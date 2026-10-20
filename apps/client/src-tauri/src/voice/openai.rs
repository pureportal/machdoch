use reqwest::{multipart, Client};
use serde::Deserialize;

use super::{
    common::{
        create_upload_filename, get_required_api_key, normalize_language_code, normalize_text,
        read_api_error, validate_audio_upload_size,
    },
    TranscribedSpeechText,
};

const OPENAI_STT_ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_STT_MODEL: &str = "gpt-transcribe";
const OPENAI_STT_PROMPT: &str = "Transcribe this short push-to-talk instruction for a desktop AI assistant. Preserve punctuation, filenames, CLI flags, code symbols, and product names when they are clear. If no intelligible speech is present, return an empty transcript. Return only the transcript.";
pub(super) const OPENAI_MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
    #[serde(default)]
    languages: Vec<OpenAiTranscriptionLanguage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiTranscriptionLanguage {
    code: String,
}

pub(super) async fn transcribe_openai(
    client: &Client,
    env: &std::collections::HashMap<String, String>,
    audio_bytes: Vec<u8>,
    mime_type: &str,
    language_code: Option<&str>,
    key_terms: &[String],
    speech_context: &str,
) -> Result<TranscribedSpeechText, String> {
    validate_audio_upload_size(audio_bytes.len(), "OpenAI", OPENAI_MAX_UPLOAD_BYTES)?;

    let api_key = get_required_api_key(env, "OPENAI_API_KEY", "OpenAI")?;
    let audio_part = multipart::Part::bytes(audio_bytes)
        .file_name(create_upload_filename(mime_type))
        .mime_str(mime_type)
        .map_err(|error| format!("Failed to prepare the audio upload: {error}"))?;

    let prompt = if speech_context.trim().is_empty() {
        OPENAI_STT_PROMPT.to_string()
    } else {
        format!(
            "{OPENAI_STT_PROMPT}\nBackground context for recognizing spoken words: {}\nUse this only to resolve ambiguous speech; do not add unspoken content.",
            speech_context.trim()
        )
    };
    let mut form = multipart::Form::new()
        .text("model", OPENAI_STT_MODEL.to_string())
        .text("response_format", "json".to_string())
        .text("prompt", prompt)
        .part("file", audio_part);

    for term in key_terms {
        form = form.text("keywords[]", term.clone());
    }

    if let Some(language_code) = normalize_language_code(language_code) {
        form = form.text("languages[]", language_code);
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
        detected_language: normalize_language_code(
            parsed
                .languages
                .first()
                .map(|language| language.code.as_str()),
        ),
    })
}
