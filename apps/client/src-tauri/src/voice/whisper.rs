use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use tauri::{path::BaseDirectory, Manager};
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use super::{local_audio, TranscribedSpeechText};

pub(super) const WHISPER_MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const BASE_MODEL_RESOURCE_PATH: &str = "whisper/ggml-base-q5_1.bin";
const TINY_MODEL_RESOURCE_PATH: &str = "whisper/ggml-tiny-q5_1.bin";

static WHISPER_STATE: OnceLock<Arc<Mutex<Option<WhisperEngine>>>> = OnceLock::new();

struct WhisperEngine {
    model_path: PathBuf,
    state: WhisperState,
    control: Box<InferenceControl>,
}

struct InferenceControl {
    cancellation: CancellationToken,
    deadline: Instant,
}

impl InferenceControl {
    fn check(&self) -> Result<(), String> {
        if self.cancellation.is_cancelled() {
            return Err("Speech transcription was cancelled.".to_string());
        }
        if Instant::now() >= self.deadline {
            return Err("Whisper transcription timed out. Try a shorter recording.".to_string());
        }
        Ok(())
    }
}

unsafe extern "C" fn abort_inference(user_data: *mut std::ffi::c_void) -> bool {
    let control = &*(user_data.cast::<InferenceControl>());
    control.check().is_err()
}

pub(super) async fn transcribe_whisper(
    app: tauri::AppHandle,
    provider: &str,
    audio_bytes: Vec<u8>,
    mime_type: &str,
    language_code: Option<&str>,
    key_terms: &[String],
    translate_to_english: bool,
    cancellation: CancellationToken,
) -> Result<TranscribedSpeechText, String> {
    if mime_type != "audio/wav" && mime_type != "audio/x-wav" {
        return Err("Whisper needs a WAV recording.".to_string());
    }
    let model_resource = match provider {
        "whisper" => BASE_MODEL_RESOURCE_PATH,
        "whisper-tiny" => TINY_MODEL_RESOURCE_PATH,
        _ => return Err("Choose a Whisper model.".to_string()),
    };
    let model_path = app
        .path()
        .resolve(model_resource, BaseDirectory::Resource)
        .map_err(|error| format!("Could not locate the bundled Whisper model: {error}"))?;
    let prompt = key_terms.join(", ").replace('\0', "");
    let language = normalize_whisper_language(language_code)?;
    transcribe_with_model(
        model_path,
        audio_bytes,
        prompt,
        language,
        translate_to_english,
        cancellation,
    )
    .await
}

async fn transcribe_with_model(
    model_path: PathBuf,
    audio_bytes: Vec<u8>,
    prompt: String,
    language: Option<String>,
    translate_to_english: bool,
    cancellation: CancellationToken,
) -> Result<TranscribedSpeechText, String> {
    let timeout = Duration::from_secs((90 + audio_bytes.len() as u64 / 16_000).clamp(90, 900));
    let control = InferenceControl {
        cancellation: cancellation.clone(),
        deadline: Instant::now() + timeout,
    };
    let inference = async move {
        let state = WHISPER_STATE
            .get_or_init(|| Arc::new(Mutex::new(None)))
            .clone()
            .lock_owned()
            .await;
        control.check()?;
        tokio::task::spawn_blocking(move || {
            transcribe_whisper_blocking(
                model_path,
                audio_bytes,
                &prompt,
                language.as_deref(),
                translate_to_english,
                state,
                control,
            )
        })
        .await
        .map_err(|error| format!("Whisper stopped unexpectedly: {error}"))?
    };
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("Speech transcription was cancelled.".to_string()),
        result = inference => result,
        _ = tokio::time::sleep(timeout) => {
            cancellation.cancel();
            Err("Whisper transcription timed out. Try a shorter recording.".to_string())
        },
    }
}

fn transcribe_whisper_blocking(
    model_path: PathBuf,
    audio_bytes: Vec<u8>,
    prompt: &str,
    language: Option<&str>,
    translate_to_english: bool,
    mut cached_state: OwnedMutexGuard<Option<WhisperEngine>>,
    control: InferenceControl,
) -> Result<TranscribedSpeechText, String> {
    control.check()?;
    let audio = decode_wav(&audio_bytes)?;
    if audio.iter().all(|sample| sample.abs() < 8.0 / 32768.0) {
        return Ok(TranscribedSpeechText {
            provider: if model_path.ends_with("ggml-tiny-q5_1.bin") {
                "whisper-tiny"
            } else {
                "whisper"
            }
            .to_string(),
            text: String::new(),
            mime_type: "audio/wav".to_string(),
            detected_language: None,
        });
    }
    if !model_path.is_file() {
        return Err("The bundled Whisper model is missing. Reinstall Machdoch.".to_string());
    }

    if cached_state
        .as_ref()
        .is_none_or(|engine| engine.model_path != model_path)
    {
        *cached_state = None;
        let mut context_params = WhisperContextParameters::default();
        context_params.flash_attn(true);
        let context = WhisperContext::new_with_params(&model_path, context_params)
            .map_err(|error| format!("Could not load the bundled Whisper model: {error}"))?;
        *cached_state = Some(WhisperEngine {
            model_path: model_path.clone(),
            state: context
                .create_state()
                .map_err(|error| format!("Could not start Whisper: {error}"))?,
            control: Box::new(InferenceControl {
                cancellation: control.cancellation.clone(),
                deadline: control.deadline,
            }),
        });
    }
    control.check()?;
    let engine = cached_state
        .as_mut()
        .expect("Whisper state was initialized");
    *engine.control = control;
    let state = &mut engine.state;
    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: 1.0,
    });
    params.set_n_threads(
        std::thread::available_parallelism().map_or(1, |count| count.get().min(4)) as i32,
    );
    params.set_language(language);
    params.set_translate(translate_to_english);
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_suppress_nst(true);
    params.set_temperature_inc(0.0);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    if !prompt.is_empty() {
        params.set_initial_prompt(prompt);
    }
    unsafe {
        params.set_abort_callback(Some(abort_inference));
        params.set_abort_callback_user_data(
            (&*engine.control as *const InferenceControl)
                .cast_mut()
                .cast(),
        );
    }
    let result = state.full(params, &audio);
    engine.control.check()?;
    result.map_err(|error| format!("Whisper transcription failed: {error}"))?;
    let mut transcript = String::new();
    for segment in state.as_iter() {
        let text = segment
            .to_str()
            .map_err(|error| format!("Whisper returned invalid text: {error}"))?;
        transcript.push_str(text);
    }
    let detected_language =
        whisper_rs::get_lang_str(state.full_lang_id_from_state()).map(str::to_string);

    Ok(TranscribedSpeechText {
        provider: if model_path.ends_with("ggml-tiny-q5_1.bin") {
            "whisper-tiny"
        } else {
            "whisper"
        }
        .to_string(),
        text: transcript.trim().to_string(),
        mime_type: "audio/wav".to_string(),
        detected_language,
    })
}

fn normalize_whisper_language(language_code: Option<&str>) -> Result<Option<String>, String> {
    let Some(language) = language_code
        .map(str::trim)
        .filter(|language| !language.is_empty())
    else {
        return Ok(None);
    };
    let language = language
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_lowercase();
    if !language
        .bytes()
        .all(|character| character.is_ascii_alphabetic())
    {
        return Err("Choose a language supported by Whisper.".to_string());
    }
    if language == "auto" {
        return Ok(None);
    }
    if whisper_rs::get_lang_id(&language).is_none() {
        return Err("Choose a language supported by Whisper.".to_string());
    }
    Ok(Some(language))
}

fn decode_wav(audio_bytes: &[u8]) -> Result<Vec<f32>, String> {
    Ok(local_audio::read_wav(audio_bytes)?
        .into_iter()
        .map(|value| value as f32 / 32768.0)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn silence_does_not_load_a_model_or_invent_a_transcript() {
        for filename in ["ggml-base-q5_1.bin", "ggml-tiny-q5_1.bin"] {
            let result = transcribe_whisper_blocking(
                PathBuf::from("missing").join(filename),
                local_audio::wav_bytes(&vec![0; 16_000]).unwrap(),
                "",
                None,
                false,
                Arc::new(Mutex::new(None)).lock_owned().await,
                InferenceControl {
                    cancellation: CancellationToken::new(),
                    deadline: Instant::now() + Duration::from_secs(30),
                },
            )
            .unwrap();
            assert!(result.text.is_empty());
            assert!(result.detected_language.is_none());
        }
    }

    #[test]
    fn reads_16_khz_mono_pcm_wav() {
        let mut bytes = Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::new(&mut bytes, spec).unwrap();
        writer.write_sample::<i16>(16384).unwrap();
        writer.finalize().unwrap();
        assert_eq!(decode_wav(&bytes.into_inner()).unwrap(), vec![0.5]);
    }

    #[tokio::test]
    #[ignore = "requires the downloaded Whisper model"]
    async fn bundled_model_transcribes_wav() {
        let model_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/whisper/ggml-base-q5_1.bin");
        let mut bytes = Cursor::new(Vec::new());
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::new(&mut bytes, spec).unwrap();
        for _ in 0..16_000 {
            writer.write_sample::<i16>(0).unwrap();
        }
        writer.finalize().unwrap();

        let state = Arc::new(Mutex::new(None)).lock_owned().await;
        let transcription = transcribe_whisper_blocking(
            model_path,
            bytes.into_inner(),
            "",
            None,
            false,
            state,
            InferenceControl {
                cancellation: CancellationToken::new(),
                deadline: Instant::now() + Duration::from_secs(30),
            },
        )
        .unwrap();
        assert_eq!(transcription.provider, "whisper");
        assert_eq!(transcription.mime_type, "audio/wav");
    }

    #[test]
    fn normalizes_language_hints_without_forcing_a_language() {
        assert_eq!(normalize_whisper_language(None).unwrap(), None);
        assert_eq!(normalize_whisper_language(Some("auto")).unwrap(), None);
        assert_eq!(
            normalize_whisper_language(Some("de-DE")).unwrap(),
            Some("de".to_string())
        );
        assert!(normalize_whisper_language(Some("invalid\0language")).is_err());
    }

    #[test]
    fn aborts_for_cancellation_and_deadlines() {
        let mut control = InferenceControl {
            cancellation: CancellationToken::new(),
            deadline: Instant::now() + Duration::from_secs(30),
        };
        let pointer = (&mut control as *mut InferenceControl).cast();
        assert!(!unsafe { abort_inference(pointer) });
        control.cancellation.cancel();
        assert!(unsafe { abort_inference(pointer) });
        control.cancellation = CancellationToken::new();
        control.deadline = Instant::now();
        assert!(unsafe { abort_inference(pointer) });
        assert!(control.check().unwrap_err().contains("timed out"));
    }

    #[tokio::test]
    async fn cancels_while_waiting_for_another_transcription() {
        let cached_state = WHISPER_STATE
            .get_or_init(|| Arc::new(Mutex::new(None)))
            .clone();
        let _guard = cached_state.lock().await;
        let cancellation = CancellationToken::new();
        let cancel = cancellation.clone();
        let inference = tokio::spawn(transcribe_with_model(
            PathBuf::new(),
            vec![0; 512],
            String::new(),
            None,
            false,
            cancellation,
        ));
        tokio::task::yield_now().await;
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), inference)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
    }

    #[tokio::test]
    #[ignore = "requires the bundled model and MACHDOCH_WHISPER_TEST_AUDIO WAV fixture"]
    async fn bundled_model_transcribes_real_speech_and_reuses_state() {
        let audio = std::fs::read(std::env::var("MACHDOCH_WHISPER_TEST_AUDIO").unwrap()).unwrap();
        for (iteration, (filename, provider)) in [
            ("ggml-base-q5_1.bin", "whisper"),
            ("ggml-tiny-q5_1.bin", "whisper-tiny"),
            ("ggml-base-q5_1.bin", "whisper"),
        ]
        .into_iter()
        .enumerate()
        {
            let model_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources/whisper")
                .join(filename);
            if iteration == 1 {
                let cancellation = CancellationToken::new();
                let inference = tokio::spawn(transcribe_with_model(
                    model_path.clone(),
                    audio.clone(),
                    String::new(),
                    None,
                    false,
                    cancellation.clone(),
                ));
                tokio::time::sleep(Duration::from_millis(50)).await;
                cancellation.cancel();
                let result = tokio::time::timeout(Duration::from_secs(1), inference)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(result.unwrap_err().contains("cancelled"));
            }
            let started = Instant::now();
            let result = transcribe_with_model(
                model_path.clone(),
                audio.clone(),
                String::new(),
                None,
                false,
                CancellationToken::new(),
            )
            .await
            .unwrap();
            eprintln!(
                "{provider} real speech pass {}: {:?}; {}",
                iteration + 1,
                started.elapsed(),
                result.text
            );
            assert_eq!(result.provider, provider);
            assert!(result
                .text
                .to_lowercase()
                .contains("ask not what your country can do for you"));
        }
    }
}
