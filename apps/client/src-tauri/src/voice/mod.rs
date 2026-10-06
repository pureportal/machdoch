use common::{
    build_http_client, decode_audio_base64, normalize_mime_type, normalize_text,
    validate_audio_base64_encoded_size,
};
use serde::Serialize;

mod common;
mod google;
mod google_response;
mod local_audio;
mod local_speech;
mod openai;
mod requests;
mod whisper;

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
    Whisper,
    WhisperTiny,
    Whistle,
    WhistleTiny,
    Phonon2,
}

impl SpeechTranscriptionProvider {
    fn from_normalized(value: &str) -> Result<Self, String> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "google" => Ok(Self::Google),
            "whisper" => Ok(Self::Whisper),
            "whisper-tiny" => Ok(Self::WhisperTiny),
            "whistle" => Ok(Self::Whistle),
            "whistle-tiny" => Ok(Self::WhistleTiny),
            "phonon2" => Ok(Self::Phonon2),
            _ => Err("Choose a speech input provider.".to_string()),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Google => "Google",
            Self::Whisper => "Whisper",
            Self::WhisperTiny => "Whisper tiny",
            Self::Whistle | Self::WhistleTiny => "Whistle",
            Self::Phonon2 => "Phonon-2",
        }
    }

    fn max_upload_bytes(self) -> usize {
        match self {
            Self::OpenAi => openai::OPENAI_MAX_UPLOAD_BYTES,
            Self::Google => google::GOOGLE_MAX_INLINE_AUDIO_BYTES,
            Self::Whisper
            | Self::WhisperTiny
            | Self::Whistle
            | Self::WhistleTiny
            | Self::Phonon2 => whisper::WHISPER_MAX_AUDIO_BYTES,
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
pub fn begin_user_speech_transcription(
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    requests::begin(window.label(), &request_id)
}

#[tauri::command]
pub fn cancel_user_speech_transcription(
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    requests::cancel(window.label(), &request_id)
}

#[tauri::command]
pub async fn transcribe_user_speech_audio(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    provider: String,
    audio_base64: String,
    mime_type: String,
    language_code: Option<String>,
    key_terms: Vec<String>,
    speech_context: String,
    auto_translate_to_english: bool,
) -> Result<TranscribedSpeechText, String> {
    let request = requests::SpeechRequest::acquire(window.label(), &request_id)?;
    let normalized_provider = provider.trim().to_lowercase();
    let transcription_provider =
        SpeechTranscriptionProvider::from_normalized(&normalized_provider)?;
    if key_terms.len() > 100
        || key_terms.iter().any(|term| {
            term.trim().is_empty()
                || term.chars().count() > 80
                || term
                    .chars()
                    .any(|character| matches!(character, '<' | '>' | '\r' | '\n' | '\0'))
        })
    {
        return Err(
            "Use up to 100 key terms of 80 characters each, without angle brackets or line breaks."
                .to_string(),
        );
    }
    if speech_context.chars().count() > 2_000 {
        return Err("Speech context must be 2,000 characters or fewer.".to_string());
    }
    let normalized_mime_type = normalize_mime_type(&mime_type)?;
    validate_audio_base64_encoded_size(
        &audio_base64,
        transcription_provider.label(),
        transcription_provider.max_upload_bytes(),
    )?;
    let audio_bytes = decode_audio_base64(&audio_base64)?;
    if matches!(
        transcription_provider,
        SpeechTranscriptionProvider::Whistle
            | SpeechTranscriptionProvider::WhistleTiny
            | SpeechTranscriptionProvider::Phonon2
    ) {
        return local_speech::transcribe(
            app,
            &normalized_provider,
            audio_bytes,
            &normalized_mime_type,
            language_code.as_deref(),
            &key_terms,
            auto_translate_to_english,
            request.cancellation.clone(),
        )
        .await;
    }
    let transcription = async {
        match transcription_provider {
            SpeechTranscriptionProvider::OpenAi => {
                let env = crate::runtime_snapshot::load_global_env()?;
                let client = build_http_client()?;
                openai::transcribe_openai(
                    &client,
                    &env,
                    audio_bytes,
                    &normalized_mime_type,
                    language_code.as_deref(),
                    &key_terms,
                    &speech_context,
                )
                .await
            }
            SpeechTranscriptionProvider::Google => {
                let env = crate::runtime_snapshot::load_global_env()?;
                let client = build_http_client()?;
                google::transcribe_google(
                    &client,
                    &env,
                    audio_bytes,
                    &normalized_mime_type,
                    language_code.as_deref(),
                    &key_terms,
                )
                .await
            }
            SpeechTranscriptionProvider::Whisper | SpeechTranscriptionProvider::WhisperTiny => {
                whisper::transcribe_whisper(
                    app,
                    &normalized_provider,
                    audio_bytes,
                    &normalized_mime_type,
                    language_code.as_deref(),
                    &key_terms,
                    auto_translate_to_english,
                    request.cancellation.clone(),
                )
                .await
            }
            SpeechTranscriptionProvider::Whistle
            | SpeechTranscriptionProvider::WhistleTiny
            | SpeechTranscriptionProvider::Phonon2 => {
                unreachable!("Local speech has already been dispatched")
            }
        }
    };
    tokio::select! {
        biased;
        _ = request.cancellation.cancelled() => Err("Speech transcription was cancelled.".to_string()),
        result = transcription => result,
        _ = tokio::time::sleep(std::time::Duration::from_secs(900)) => Err("Speech transcription timed out. Try a shorter recording.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcribe_rejects_unsupported_provider() {
        let result = SpeechTranscriptionProvider::from_normalized("unsupported");
        assert_eq!(result.unwrap_err(), "Choose a speech input provider.");
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
        assert!(google_error.contains("Google speech-to-text uploads are limited to 14 MB"));
    }
}
