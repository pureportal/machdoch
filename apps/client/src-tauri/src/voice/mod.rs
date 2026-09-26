use common::{
    build_http_client, decode_audio_base64, normalize_mime_type, normalize_text,
    validate_audio_base64_encoded_size,
};
use serde::Serialize;

mod common;
mod google;
mod google_response;
mod openai;
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
}

impl SpeechTranscriptionProvider {
    fn from_normalized(value: &str) -> Result<Self, String> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "google" => Ok(Self::Google),
            "whisper" => Ok(Self::Whisper),
            _ => Err("Expected provider to be one of openai, google, or whisper.".to_string()),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Google => "Google",
            Self::Whisper => "Whisper",
        }
    }

    fn max_upload_bytes(self) -> usize {
        match self {
            Self::OpenAi => openai::OPENAI_MAX_UPLOAD_BYTES,
            Self::Google => google::GOOGLE_MAX_INLINE_AUDIO_BYTES,
            Self::Whisper => whisper::WHISPER_MAX_AUDIO_BYTES,
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
    app: tauri::AppHandle,
    provider: String,
    audio_base64: String,
    mime_type: String,
    language_code: Option<String>,
    key_terms: Vec<String>,
    speech_context: String,
    auto_translate_to_english: bool,
) -> Result<TranscribedSpeechText, String> {
    let normalized_provider = provider.trim().to_lowercase();
    let transcription_provider =
        SpeechTranscriptionProvider::from_normalized(&normalized_provider)?;
    if key_terms.len() > 100
        || key_terms.iter().any(|term| {
            term.trim().is_empty()
                || term.chars().count() > 80
                || term
                    .chars()
                    .any(|character| matches!(character, '<' | '>' | '\r' | '\n'))
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
        SpeechTranscriptionProvider::Whisper => {
            whisper::transcribe_whisper(
                app,
                audio_bytes,
                &normalized_mime_type,
                &key_terms,
                auto_translate_to_english,
            )
            .await
        }
    }
}

fn speech_text_instruction(auto_translate_to_english: bool, auto_format: bool) -> String {
    let mut instruction = String::from("Edit the speech transcript below. Return only the edited text. Preserve the speaker's meaning, requests, facts, names, paths, code, and technical terms. Do not add ideas or commentary.");
    if auto_translate_to_english {
        instruction.push_str(" Translate non-English speech into natural English. Keep content that is already English in English.");
    }
    if auto_format {
        instruction.push_str(" Correct grammar, punctuation, and wording. Organize distinct requested changes as a Markdown list. Use paragraphs or other Markdown structure when appropriate.");
    }
    instruction
}

#[tauri::command]
pub async fn process_user_speech_text(
    provider: String,
    text: String,
    auto_translate_to_english: bool,
    auto_format: bool,
) -> Result<String, String> {
    let normalized_provider =
        SpeechTranscriptionProvider::from_normalized(&provider.trim().to_lowercase())?;
    let normalized_text = normalize_text(&text)?;
    if !auto_translate_to_english && !auto_format {
        return Ok(normalized_text);
    }
    if normalized_text.chars().count() > 20_000 {
        return Err("Speech transcript is too long to process.".to_string());
    }
    if normalized_provider == SpeechTranscriptionProvider::Whisper {
        return if auto_format {
            Err("Formatting is unavailable with local Whisper.".to_string())
        } else {
            Ok(normalized_text)
        };
    }
    let env = crate::runtime_snapshot::load_global_env()?;
    let client = build_http_client()?;
    let instruction = speech_text_instruction(auto_translate_to_english, auto_format);
    match normalized_provider {
        SpeechTranscriptionProvider::OpenAi => {
            openai::process_openai_text(&client, &env, &normalized_text, &instruction).await
        }
        SpeechTranscriptionProvider::Google => {
            google::process_google_text(&client, &env, &normalized_text, &instruction).await
        }
        SpeechTranscriptionProvider::Whisper => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_text_instruction_requests_markdown_lists_for_distinct_changes() {
        let instruction = speech_text_instruction(true, true);
        assert!(instruction.contains("natural English"));
        assert!(instruction.contains("Markdown list"));
        assert!(!speech_text_instruction(false, false).contains("Markdown list"));
    }

    #[test]
    fn transcribe_rejects_unsupported_provider() {
        let result = SpeechTranscriptionProvider::from_normalized("unsupported");
        assert_eq!(
            result.unwrap_err(),
            "Expected provider to be one of openai, google, or whisper."
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
        assert!(google_error.contains("Google speech-to-text uploads are limited to 14 MB"));
    }
}
