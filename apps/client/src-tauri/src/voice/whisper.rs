use std::{
    io::Cursor,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use tauri::{path::BaseDirectory, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::TranscribedSpeechText;

pub(super) const WHISPER_MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const MODEL_RESOURCE_PATH: &str = "whisper/ggml-large-v3-q5_0.bin";

static WHISPER_CONTEXT: OnceLock<Mutex<Option<WhisperContext>>> = OnceLock::new();

pub(super) async fn transcribe_whisper(
    app: tauri::AppHandle,
    audio_bytes: Vec<u8>,
    mime_type: &str,
    key_terms: &[String],
    translate_to_english: bool,
) -> Result<TranscribedSpeechText, String> {
    if mime_type != "audio/wav" && mime_type != "audio/x-wav" {
        return Err("Whisper needs a WAV recording.".to_string());
    }
    let model_path = app
        .path()
        .resolve(MODEL_RESOURCE_PATH, BaseDirectory::Resource)
        .map_err(|error| format!("Could not locate the bundled Whisper model: {error}"))?;
    let prompt = key_terms.join(", ").replace('\0', "");
    tokio::task::spawn_blocking(move || {
        transcribe_whisper_blocking(model_path, audio_bytes, &prompt, translate_to_english)
    })
    .await
    .map_err(|error| format!("Whisper stopped unexpectedly: {error}"))?
}

fn transcribe_whisper_blocking(
    model_path: PathBuf,
    audio_bytes: Vec<u8>,
    prompt: &str,
    translate_to_english: bool,
) -> Result<TranscribedSpeechText, String> {
    let audio = decode_wav(&audio_bytes)?;
    if !model_path.is_file() {
        return Err("The bundled Whisper model is missing. Reinstall Machdoch.".to_string());
    }

    let context = WHISPER_CONTEXT.get_or_init(|| Mutex::new(None));
    let mut context = context
        .lock()
        .map_err(|_| "Whisper is unavailable after an inference failure.".to_string())?;
    if context.is_none() {
        *context = Some(
            WhisperContext::new_with_params(&model_path, WhisperContextParameters::default())
                .map_err(|error| format!("Could not load the bundled Whisper model: {error}"))?,
        );
    }
    let whisper = context.as_ref().expect("Whisper context was initialized");
    let mut state = whisper
        .create_state()
        .map_err(|error| format!("Could not start Whisper: {error}"))?;
    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: -1.0,
    });
    params.set_language(None);
    params.set_translate(translate_to_english);
    params.set_no_timestamps(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    if !prompt.is_empty() {
        params.set_initial_prompt(prompt);
    }
    state
        .full(params, &audio)
        .map_err(|error| format!("Whisper transcription failed: {error}"))?;
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
        provider: "whisper".to_string(),
        text: transcript.trim().to_string(),
        mime_type: "audio/wav".to_string(),
        detected_language,
    })
}

fn decode_wav(audio_bytes: &[u8]) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::new(Cursor::new(audio_bytes))
        .map_err(|error| format!("Whisper could not read the WAV recording: {error}"))?;
    let spec = reader.spec();
    if spec.channels != 1
        || spec.sample_rate != 16_000
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        return Err("Whisper needs 16 kHz mono PCM WAV audio.".to_string());
    }
    reader
        .samples::<i16>()
        .map(|sample| {
            sample
                .map(|value| value as f32 / 32768.0)
                .map_err(|error| format!("Whisper could not read the WAV recording: {error}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    #[ignore = "requires the downloaded Whisper model"]
    fn bundled_model_transcribes_wav() {
        let model_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/whisper/ggml-large-v3-q5_0.bin");
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

        let transcription =
            transcribe_whisper_blocking(model_path, bytes.into_inner(), "", false).unwrap();
        assert_eq!(transcription.provider, "whisper");
        assert_eq!(transcription.mime_type, "audio/wav");
    }
}
