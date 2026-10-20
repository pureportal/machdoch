use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use super::{
    common::{
        get_required_api_key, normalize_language_code, read_api_error, validate_audio_upload_size,
    },
    TranscribedSpeechText,
};

const GOOGLE_STT_ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GOOGLE_STT_MODEL: &str = "gemini-3.5-transcribe";
pub(super) const GOOGLE_MAX_INLINE_AUDIO_BYTES: usize = 14 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct GoogleInteractionResponse {
    steps: Vec<GoogleInteractionStep>,
}

#[derive(Debug, Deserialize)]
struct GoogleInteractionStep {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    content: Vec<GoogleInteractionContent>,
}

#[derive(Debug, Deserialize)]
struct GoogleInteractionContent {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

fn extract_google_interaction_transcript(
    response: GoogleInteractionResponse,
) -> Result<String, String> {
    let transcript = response
        .steps
        .iter()
        .filter(|step| step.kind == "model_output")
        .flat_map(|step| &step.content)
        .filter(|content| content.kind == "text")
        .filter_map(|content| content.text.as_deref())
        .collect::<Vec<_>>()
        .join("");
    let transcript = transcript.trim();
    if transcript.is_empty() {
        return Err("Google returned an empty transcript.".to_string());
    }
    Ok(transcript.to_string())
}

pub(super) async fn transcribe_google(
    client: &Client,
    env: &std::collections::HashMap<String, String>,
    audio_bytes: Vec<u8>,
    mime_type: &str,
    language_code: Option<&str>,
    key_terms: &[String],
) -> Result<TranscribedSpeechText, String> {
    validate_audio_upload_size(audio_bytes.len(), "Google", GOOGLE_MAX_INLINE_AUDIO_BYTES)?;

    let api_key = get_required_api_key(env, "GOOGLE_API_KEY", "Google")?;
    let mut transcription_config = json!({});
    if let Some(language_code) = normalize_language_code(language_code) {
        transcription_config["language_codes"] = json!([language_code]);
    }
    if !key_terms.is_empty() {
        transcription_config["custom_vocabulary"] = json!(key_terms);
    }
    let request_body = json!({
        "model": GOOGLE_STT_MODEL,
        "input": [{
            "type": "audio",
            "data": BASE64_STANDARD.encode(audio_bytes),
            "mime_type": mime_type
        }],
        "generation_config": { "transcription_config": transcription_config }
    });

    let response = client
        .post(GOOGLE_STT_ENDPOINT)
        .header("x-goog-api-key", api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|error| format!("Google Gemini speech-to-text request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Google Gemini speech-to-text request failed: {}",
            read_api_error(response).await
        ));
    }

    let parsed = response
        .json::<GoogleInteractionResponse>()
        .await
        .map_err(|error| {
            format!("Failed to parse Google Gemini speech-to-text response: {error}")
        })?;
    let transcript = extract_google_interaction_transcript(parsed)?;

    Ok(TranscribedSpeechText {
        provider: "google".to_string(),
        text: transcript,
        mime_type: mime_type.to_string(),
        detected_language: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_transcript_from_interaction_response() {
        let response = serde_json::from_value(json!({
            "steps": [{
                "type": "model_output",
                "content": [{ "type": "text", "text": "Open Machdoch." }]
            }]
        }))
        .unwrap();
        assert_eq!(
            extract_google_interaction_transcript(response).unwrap(),
            "Open Machdoch."
        );
    }

}
