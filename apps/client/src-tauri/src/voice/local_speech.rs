use super::{local_audio, TranscribedSpeechText};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};
use tauri::{path::BaseDirectory, Manager};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Mutex,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

static INFERENCE: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transcript {
    text: String,
    #[serde(default, alias = "language")]
    detected_language: Option<String>,
}

struct RecordingDirectory(PathBuf);

impl RecordingDirectory {
    fn create() -> Result<Self, String> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|error| error.to_string())?;
        let name = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = std::env::temp_dir().join(format!("machdoch-speech-{name}"));
        #[cfg(unix)]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(not(unix))]
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|error| format!("Could not prepare the recording: {error}"))?;
        Ok(Self(path))
    }
}

impl Drop for RecordingDirectory {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            eprintln!("Could not remove temporary speech recording: {error}");
        }
    }
}

async fn bounded_output(reader: impl AsyncRead + Unpin, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("The speech runtime returned too much output.".to_string());
    }
    Ok(bytes)
}

async fn execute(
    mut command: Command,
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<Transcript, String> {
    command
        .env("NEEDLE_TELEMETRY", "0")
        .env("DO_NOT_TRACK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|error| {
        format!("Could not start local speech recognition: {error}. Reinstall Machdoch.")
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or("The speech runtime did not open its output.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("The speech runtime did not open its error output.")?;
    let result = {
        let output = async {
            tokio::try_join!(
                bounded_output(stdout, 1_048_576),
                bounded_output(stderr, 65_536),
                async { child.wait().await.map_err(|error| error.to_string()) }
            )
        };
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err("Speech transcription was cancelled.".to_string()),
            _ = tokio::time::sleep_until(deadline) => Err("Speech transcription timed out. Try a shorter recording.".to_string()),
            result = output => result,
        }
    };
    let (stdout, stderr, status) = match result {
        Ok(output) => output,
        Err(error) => {
            child.kill().await.map_err(|failure| {
                format!("{error} Could not stop the speech runtime: {failure}")
            })?;
            return Err(error);
        }
    };
    if !status.success() {
        if stderr.iter().all(u8::is_ascii_whitespace) {
            return Err(
                "Local speech recognition stopped unexpectedly. Reinstall Machdoch.".to_string(),
            );
        }
        return Err(format!(
            "Local speech recognition failed: {}",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    serde_json::from_slice(&stdout)
        .map_err(|error| format!("The speech runtime returned invalid text: {error}"))
}

pub(super) async fn transcribe(
    app: tauri::AppHandle,
    provider: &str,
    bytes: Vec<u8>,
    mime: &str,
    language: Option<&str>,
    key_terms: &[String],
    translate: bool,
    cancellation: CancellationToken,
) -> Result<TranscribedSpeechText, String> {
    if !matches!(mime, "audio/wav" | "audio/x-wav") {
        return Err("Local speech recognition needs a WAV recording.".to_string());
    }
    if translate {
        return Err("Choose Whisper to translate speech to English.".to_string());
    }
    if provider == "phonon2" && key_terms.len() > 25 {
        return Err(
            "Phonon-2 accepts up to 25 key terms. Remove extra terms in speech settings."
                .to_string(),
        );
    }
    let language = language
        .map(|language| {
            language
                .trim()
                .split(['-', '_'])
                .next()
                .unwrap_or_default()
                .to_lowercase()
        })
        .filter(|language| !matches!(language.as_str(), "" | "auto"));
    if language.as_deref().is_some_and(|language| {
        if provider == "phonon2" {
            language != "en"
        } else {
            !["en", "de", "fr", "es", "it", "nl", "pl"].contains(&language)
        }
    }) {
        return Err("Choose a language supported by the selected speech model.".to_string());
    }
    let samples = local_audio::read_wav(&bytes)?;
    if samples.iter().all(|sample| sample.unsigned_abs() < 8) {
        return Ok(TranscribedSpeechText {
            provider: provider.to_string(),
            text: String::new(),
            mime_type: "audio/wav".to_string(),
            detected_language: None,
        });
    }
    let startup_budget = if provider == "phonon2" { 300 } else { 90 };
    let timeout = Duration::from_secs(
        (startup_budget + samples.len() as u64 / 4_000).clamp(startup_budget, 900),
    );
    let deadline = Instant::now() + timeout;
    let _guard = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err("Speech transcription was cancelled.".to_string()),
        _ = tokio::time::sleep_until(deadline) => return Err("Speech transcription timed out. Try a shorter recording.".to_string()),
        guard = INFERENCE.get_or_init(|| Mutex::new(())).lock() => guard,
    };
    let root = app
        .path()
        .resolve("speech", BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;
    let worker = app
        .path()
        .resolve("python/local_speech_worker.py", BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;
    transcribe_with_paths(
        &root,
        &worker,
        provider,
        &bytes,
        &samples,
        language.as_deref(),
        key_terms,
        &cancellation,
        deadline,
    )
    .await
}

async fn transcribe_with_paths(
    root: &Path,
    worker: &Path,
    provider: &str,
    bytes: &[u8],
    samples: &[i16],
    language: Option<&str>,
    key_terms: &[String],
    cancellation: &CancellationToken,
    deadline: Instant,
) -> Result<TranscribedSpeechText, String> {
    let temporary = RecordingDirectory::create()?;
    let audio = temporary.0.join("recording.wav");
    let keywords = temporary.0.join("keywords.txt");
    tokio::fs::write(&keywords, key_terms.join("\n"))
        .await
        .map_err(|error| error.to_string())?;
    let mut result = TranscribedSpeechText {
        provider: provider.to_string(),
        text: String::new(),
        mime_type: "audio/wav".to_string(),
        detected_language: None,
    };
    if provider == "phonon2" {
        tokio::fs::write(&audio, bytes)
            .await
            .map_err(|error| error.to_string())?;
        let python = root.join(if cfg!(windows) {
            "runtime/python.exe"
        } else {
            "runtime/bin/python3"
        });
        let mut command = Command::new(python);
        command
            .arg("-I")
            .arg(worker)
            .arg("--resource-dir")
            .arg(root)
            .arg("--audio")
            .arg(&audio);
        if let Some(language) = language {
            command.arg("--language").arg(language);
        }
        for term in key_terms {
            command.arg(format!("--key-term={term}"));
        }
        let transcript = execute(command, cancellation, deadline).await?;
        result.text = transcript.text;
        result.detected_language = transcript.detected_language;
    } else {
        let executable = root.join(if cfg!(windows) {
            "bin/needle.exe"
        } else {
            "bin/needle"
        });
        for range in local_audio::chunk_ranges(samples) {
            tokio::fs::write(&audio, local_audio::wav_bytes(&samples[range])?)
                .await
                .map_err(|error| error.to_string())?;
            let mut command = Command::new(&executable);
            command
                .arg("--model")
                .arg(root.join("whistle.cact"))
                .arg("--audio")
                .arg(&audio)
                .arg("--audio-depth")
                .arg(if provider == "whistle-tiny" { "2" } else { "8" })
                .arg("--threads")
                .arg("4");
            if let Some(language) = language {
                command.arg("--audio-language").arg(language);
            }
            if !key_terms.is_empty() {
                command.arg("--audio-keywords").arg(&keywords);
            }
            let transcript = execute(command, cancellation, deadline).await?;
            if !result.text.is_empty() && !transcript.text.trim().is_empty() {
                result.text.push(' ');
            }
            result.text.push_str(transcript.text.trim());
            if result.detected_language.is_none() {
                result.detected_language = transcript.detected_language;
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_private_recordings_after_completion() {
        let path;
        {
            let directory = RecordingDirectory::create().unwrap();
            path = directory.0.clone();
            std::fs::write(path.join("recording.wav"), b"private audio").unwrap();
        }
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn rejects_excess_runtime_output() {
        assert!(bounded_output(&b"abcd"[..], 3)
            .await
            .unwrap_err()
            .contains("too much output"));
        assert_eq!(bounded_output(&b"abc"[..], 3).await.unwrap(), b"abc");
    }

    #[tokio::test]
    #[ignore = "requires prepared local speech resources and MACHDOCH_WHISPER_TEST_AUDIO"]
    async fn bundled_models_transcribe_real_speech() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = directory.join("resources/speech");
        let audio = std::fs::read(std::env::var("MACHDOCH_WHISPER_TEST_AUDIO").unwrap()).unwrap();
        let samples = local_audio::read_wav(&audio).unwrap();
        for provider in ["whistle", "whistle-tiny", "phonon2"] {
            let started = Instant::now();
            let result = transcribe_with_paths(
                &root,
                &directory.join("python/local_speech_worker.py"),
                provider,
                &audio,
                &samples,
                Some("en"),
                &["country".to_string()],
                &CancellationToken::new(),
                started + Duration::from_secs(360),
            )
            .await
            .unwrap();
            eprintln!("{provider}: {:?}; {}", started.elapsed(), result.text);
            assert_eq!(result.provider, provider);
            assert_eq!(result.detected_language.as_deref(), Some("en"));
            assert!(result
                .text
                .to_lowercase()
                .contains("ask not what your country can do for you"));
        }
    }

    #[tokio::test]
    #[ignore = "requires the bundled Python runtime"]
    async fn disables_native_speech_telemetry() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/speech/runtime");
        let python = root.join(if cfg!(windows) {
            "python.exe"
        } else {
            "bin/python3"
        });
        let mut command = Command::new(python);
        command
            .env("NEEDLE_TELEMETRY", "1")
            .env("DO_NOT_TRACK", "0")
            .arg("-I")
            .arg("-c")
            .arg("import json, os; print(json.dumps({'text': os.environ['NEEDLE_TELEMETRY'] + '/' + os.environ['DO_NOT_TRACK']}))");
        let result = execute(
            command,
            &CancellationToken::new(),
            Instant::now() + Duration::from_secs(30),
        )
        .await
        .unwrap();
        assert_eq!(result.text, "0/1");
    }

    #[tokio::test]
    #[ignore = "requires the bundled Python runtime"]
    async fn stops_runtime_on_cancellation_and_deadline() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/speech/runtime");
        let python = root.join(if cfg!(windows) {
            "python.exe"
        } else {
            "bin/python3"
        });
        for cancel in [true, false] {
            let mut command = Command::new(&python);
            command
                .arg("-I")
                .arg("-c")
                .arg("import time; time.sleep(60)");
            let cancellation = CancellationToken::new();
            if cancel {
                let token = cancellation.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    token.cancel();
                });
            }
            let started = Instant::now();
            let error = execute(command, &cancellation, started + Duration::from_millis(300))
                .await
                .err()
                .unwrap();
            assert!(error.contains(if cancel { "cancelled" } else { "timed out" }));
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }
}
