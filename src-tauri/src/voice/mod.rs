use common::{
    build_http_client, decode_audio_base64, normalize_mime_type, normalize_text,
    validate_audio_base64_encoded_size,
};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpeechTranscriptionProvider {
    OpenAi,
    Google,
}

impl SpeechTranscriptionProvider {
    fn from_normalized(value: &str) -> Result<Self, String> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "google" => Ok(Self::Google),
            _ => Err("Expected provider to be one of openai or google.".to_string()),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Google => "Google",
        }
    }

    fn max_upload_bytes(self) -> usize {
        match self {
            Self::OpenAi => openai::OPENAI_MAX_UPLOAD_BYTES,
            Self::Google => google::GOOGLE_MAX_INLINE_AUDIO_BYTES,
        }
    }
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
    let transcription_provider =
        SpeechTranscriptionProvider::from_normalized(&normalized_provider)?;
    let normalized_mime_type = normalize_mime_type(&mime_type)?;
    validate_audio_base64_encoded_size(
        &audio_base64,
        transcription_provider.label(),
        transcription_provider.max_upload_bytes(),
    )?;
    let audio_bytes = decode_audio_base64(&audio_base64)?;
    let env = crate::runtime_snapshot::load_global_env()?;
    let client = build_http_client()?;

    match transcription_provider {
        SpeechTranscriptionProvider::OpenAi => {
            openai::transcribe_openai(
                &client,
                &env,
                audio_bytes,
                &normalized_mime_type,
                language_code.as_deref(),
            )
            .await
        }
        SpeechTranscriptionProvider::Google => {
            google::transcribe_google(
                &client,
                &env,
                audio_bytes,
                &normalized_mime_type,
                language_code.as_deref(),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transcribe_rejects_unsupported_provider_before_audio_validation() {
        let result = transcribe_user_speech_audio(
            "unsupported".to_string(),
            "not valid base64".to_string(),
            "not-an-audio-mime-type".to_string(),
            None,
        )
        .await;

        assert_eq!(
            result.unwrap_err(),
            "Expected provider to be one of openai or google."
        );
    }

    #[test]
    fn transcription_provider_exposes_provider_specific_upload_limits() {
        assert_eq!(
            SpeechTranscriptionProvider::from_normalized("openai")
                .unwrap()
                .max_upload_bytes(),
            openai::OPENAI_MAX_UPLOAD_BYTES
        );
        assert_eq!(
            SpeechTranscriptionProvider::from_normalized("google")
                .unwrap()
                .max_upload_bytes(),
            google::GOOGLE_MAX_INLINE_AUDIO_BYTES
        );
    }

    #[test]
    fn encoded_size_preflight_rejects_openai_and_google_lengths_above_upload_limits() {
        let openai_error = common::validate_audio_base64_encoded_len(
            openai::OPENAI_MAX_UPLOAD_BYTES / 3 * 4 + 5,
            SpeechTranscriptionProvider::OpenAi.label(),
            SpeechTranscriptionProvider::OpenAi.max_upload_bytes(),
        )
        .unwrap_err();
        let google_error = common::validate_audio_base64_encoded_len(
            google::GOOGLE_MAX_INLINE_AUDIO_BYTES / 3 * 4 + 5,
            SpeechTranscriptionProvider::Google.label(),
            SpeechTranscriptionProvider::Google.max_upload_bytes(),
        )
        .unwrap_err();

        assert!(openai_error.contains("OpenAI speech-to-text uploads are limited to 25 MB"));
        assert!(google_error.contains("Google speech-to-text uploads are limited to 20 MB"));
    }
}
