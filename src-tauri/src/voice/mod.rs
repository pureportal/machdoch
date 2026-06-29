use common::{build_http_client, decode_audio_base64, normalize_mime_type, normalize_text};
use serde::Serialize;

mod common;
mod google;
mod google_response;
mod openai;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizedVoiceAudio {
    provider: String,
    mime_type: String,
    audio_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribedSpeechText {
    provider: String,
    text: String,
    mime_type: String,
    detected_language: Option<String>,
}

#[tauri::command]
pub async fn synthesize_user_voice_audio(
    provider: String,
    text: String,
    language_code: Option<String>,
    rate: Option<f64>,
) -> Result<SynthesizedVoiceAudio, String> {
    let normalized_provider = provider.trim().to_lowercase();
    let normalized_text = normalize_text(&text)?;
    let env = crate::runtime_snapshot::load_global_env()?;
    let client = build_http_client()?;

    match normalized_provider.as_str() {
        "openai" => openai::synthesize_openai(&client, &env, &normalized_text, rate).await,
        "google" => {
            google::synthesize_google(
                &client,
                &env,
                &normalized_text,
                language_code.as_deref(),
                rate,
            )
            .await
        }
        _ => Err("Expected provider to be one of openai or google.".to_string()),
    }
}

#[tauri::command]
pub async fn transcribe_user_speech_audio(
    provider: String,
    audio_base64: String,
    mime_type: String,
    language_code: Option<String>,
) -> Result<TranscribedSpeechText, String> {
    let normalized_provider = provider.trim().to_lowercase();
    let normalized_mime_type = normalize_mime_type(&mime_type)?;
    let audio_bytes = decode_audio_base64(&audio_base64)?;
    let env = crate::runtime_snapshot::load_global_env()?;
    let client = build_http_client()?;

    match normalized_provider.as_str() {
        "openai" => {
            openai::transcribe_openai(
                &client,
                &env,
                audio_bytes,
                &normalized_mime_type,
                language_code.as_deref(),
            )
            .await
        }
        "google" => {
            google::transcribe_google(
                &client,
                &env,
                audio_bytes,
                &normalized_mime_type,
                language_code.as_deref(),
            )
            .await
        }
        _ => Err("Expected provider to be one of openai or google.".to_string()),
    }
}
