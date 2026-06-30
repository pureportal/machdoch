use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use reqwest::{multipart, Client};
use serde::Deserialize;
use serde_json::json;

use super::{
    common::{
        create_upload_filename, get_required_api_key, normalize_language_code, normalize_text,
        read_api_error, validate_audio_upload_size,
    },
    SynthesizedVoiceAudio, TranscribedSpeechText,
};

const OPENAI_TTS_ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
const OPENAI_TTS_MODEL: &str = "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE: &str = "cedar";
const OPENAI_TTS_INSTRUCTIONS: &str =
    "Speak in a clear, friendly, helpful tone for a desktop AI assistant.";
const OPENAI_MAX_INPUT_CHARS: usize = 4096;
const OPENAI_STT_ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_STT_MODEL: &str = "gpt-4o-transcribe";
const OPENAI_STT_PROMPT: &str = "Transcribe this short push-to-talk instruction for a desktop AI assistant. Preserve punctuation, filenames, CLI flags, code symbols, and product names when they are clear. If no intelligible speech is present, return an empty transcript. Return only the transcript.";
pub(super) const OPENAI_MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
    language: Option<String>,
}

fn clamp_openai_speed(value: Option<f64>) -> f64 {
    let Some(value) = value.filter(|value| value.is_finite()) else {
        return 1.0;
    };

    value.clamp(0.25, 4.0)
}

pub(super) async fn synthesize_openai(
    client: &Client,
    env: &std::collections::HashMap<String, String>,
    text: &str,
    rate: Option<f64>,
) -> Result<SynthesizedVoiceAudio, String> {
    if text.chars().count() > OPENAI_MAX_INPUT_CHARS {
        return Err(format!(
            "OpenAI speech requests are limited to {OPENAI_MAX_INPUT_CHARS} characters."
        ));
    }

    let api_key = get_required_api_key(env, "OPENAI_API_KEY", "OpenAI")?;
    let response = client
        .post(OPENAI_TTS_ENDPOINT)
        .bearer_auth(api_key)
        .json(&json!({
            "model": OPENAI_TTS_MODEL,
            "voice": OPENAI_TTS_VOICE,
            "input": text,
            "instructions": OPENAI_TTS_INSTRUCTIONS,
            "response_format": "wav",
            "speed": clamp_openai_speed(rate),
        }))
        .send()
        .await
        .map_err(|error| format!("OpenAI speech request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "OpenAI speech request failed: {}",
            read_api_error(response).await
        ));
    }

    let audio_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read OpenAI speech audio: {error}"))?;

    Ok(SynthesizedVoiceAudio {
        provider: "openai".to_string(),
        mime_type: "audio/wav".to_string(),
        audio_base64: BASE64_STANDARD.encode(audio_bytes),
    })
}

pub(super) async fn transcribe_openai(
    client: &Client,
    env: &std::collections::HashMap<String, String>,
    audio_bytes: Vec<u8>,
    mime_type: &str,
    language_code: Option<&str>,
) -> Result<TranscribedSpeechText, String> {
    validate_audio_upload_size(audio_bytes.len(), "OpenAI", OPENAI_MAX_UPLOAD_BYTES)?;

    let api_key = get_required_api_key(env, "OPENAI_API_KEY", "OpenAI")?;
    let audio_part = multipart::Part::bytes(audio_bytes)
        .file_name(create_upload_filename(mime_type))
        .mime_str(mime_type)
        .map_err(|error| format!("Failed to prepare the audio upload: {error}"))?;

    let mut form = multipart::Form::new()
        .text("model", OPENAI_STT_MODEL.to_string())
        .text("response_format", "json".to_string())
        .text("prompt", OPENAI_STT_PROMPT.to_string())
        .part("file", audio_part);

    if let Some(language_code) = normalize_language_code(language_code) {
        form = form.text("language", language_code);
    }

    let response = client
        .post(OPENAI_STT_ENDPOINT)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("OpenAI speech-to-text request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "OpenAI speech-to-text request failed: {}",
            read_api_error(response).await
        ));
    }

    let parsed = response
        .json::<OpenAiTranscriptionResponse>()
        .await
        .map_err(|error| format!("Failed to parse OpenAI speech-to-text response: {error}"))?;
    let transcript = normalize_text(&parsed.text)
        .map_err(|_| "OpenAI returned an empty transcript.".to_string())?;

    Ok(TranscribedSpeechText {
        provider: "openai".to_string(),
        text: transcript,
        mime_type: mime_type.to_string(),
        detected_language: normalize_language_code(parsed.language.as_deref()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_openai_speed_uses_default_for_missing_or_invalid_values() {
        assert_eq!(clamp_openai_speed(None), 1.0);
        assert_eq!(clamp_openai_speed(Some(f64::NAN)), 1.0);
    }

    #[test]
    fn clamp_openai_speed_keeps_value_within_openai_bounds() {
        assert_eq!(clamp_openai_speed(Some(0.1)), 0.25);
        assert_eq!(clamp_openai_speed(Some(2.0)), 2.0);
        assert_eq!(clamp_openai_speed(Some(8.0)), 4.0);
    }
}
