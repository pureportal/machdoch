use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use super::{
    common::{
        get_required_api_key, normalize_language_code, read_api_error, validate_audio_upload_size,
    },
    google_response::{
        extract_google_audio, extract_google_transcript, GoogleAudioExtractionFailure,
        GoogleGenerateContentResponse,
    },
    SynthesizedVoiceAudio, TranscribedSpeechText,
};

const GOOGLE_TTS_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent";
const GOOGLE_STT_ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GOOGLE_STT_MODEL: &str = "gemini-3.5-transcribe";
const GOOGLE_TEXT_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
const GOOGLE_TTS_VOICE: &str = "Kore";
const GOOGLE_TTS_RETRY_COUNT: usize = 2;
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

fn create_google_pace_instruction(rate: Option<f64>) -> Option<String> {
    let rate = rate.filter(|value| value.is_finite())?;

    if (rate - 1.0).abs() < 0.05 {
        return None;
    }

    if rate > 1.0 {
        return Some(format!(
            "Keep the spoken delivery brisk at roughly {:.2}x normal pace.",
            rate
        ));
    }

    Some(format!(
        "Keep the spoken delivery calm and slightly slower at roughly {:.2}x normal pace.",
        rate
    ))
}

fn create_google_prompt(text: &str, rate: Option<f64>) -> String {
    let pace_instruction = create_google_pace_instruction(rate)
        .map(|instruction| format!("\n- {instruction}"))
        .unwrap_or_default();

    format!(
        "Synthesize speech for the transcript below.\n\
         - Use a clear, friendly, helpful desktop-assistant tone.{pace_instruction}\n\n\
         ### TRANSCRIPT\n{text}"
    )
}

pub(super) async fn process_google_text(
    client: &Client,
    env: &std::collections::HashMap<String, String>,
    text: &str,
    instruction: &str,
) -> Result<String, String> {
    let api_key = get_required_api_key(env, "GOOGLE_API_KEY", "Google")?;
    let response = client
        .post(GOOGLE_TEXT_ENDPOINT)
        .query(&[("key", api_key.as_str())])
        .json(&json!({
            "systemInstruction": { "parts": [{ "text": instruction }] },
            "contents": [{ "parts": [{ "text": text }] }],
            "generationConfig": { "responseMimeType": "text/plain", "temperature": 0.1 }
        }))
        .send()
        .await
        .map_err(|error| format!("Google Gemini speech text processing failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Google Gemini speech text processing failed: {}",
            read_api_error(response).await
        ));
    }
    let parsed = response
        .json::<GoogleGenerateContentResponse>()
        .await
        .map_err(|error| format!("Failed to parse Google Gemini speech text response: {error}"))?;
    extract_google_transcript(parsed)
}

fn google_tts_failure_is_retryable(failure: &GoogleAudioExtractionFailure) -> bool {
    matches!(failure, GoogleAudioExtractionFailure::Retryable(_))
}

pub(super) async fn synthesize_google(
    client: &Client,
    env: &std::collections::HashMap<String, String>,
    text: &str,
    language_code: Option<&str>,
    rate: Option<f64>,
) -> Result<SynthesizedVoiceAudio, String> {
    let api_key = get_required_api_key(env, "GOOGLE_API_KEY", "Google")?;
    let speech_config = if let Some(language_code) = normalize_language_code(language_code) {
        json!({
            "voiceConfig": {
                "prebuiltVoiceConfig": {
                    "voiceName": GOOGLE_TTS_VOICE,
                }
            },
            "languageCode": language_code,
        })
    } else {
        json!({
            "voiceConfig": {
                "prebuiltVoiceConfig": {
                    "voiceName": GOOGLE_TTS_VOICE,
                }
            }
        })
    };
    let request_body = json!({
        "systemInstruction": {
            "parts": [
                {
                    "text": "You are a text-to-speech model. Generate speech audio only. Speak only the transcript content. Do not speak section labels or instructions."
                }
            ]
        },
        "contents": [
            {
                "parts": [
                    {
                        "text": create_google_prompt(text, rate)
                    }
                ]
            }
        ],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": speech_config,
        }
    });

    let mut last_error = None;

    for attempt in 0..GOOGLE_TTS_RETRY_COUNT {
        let response = client
            .post(GOOGLE_TTS_ENDPOINT)
            .query(&[("key", api_key.as_str())])
            .json(&request_body)
            .send()
            .await
            .map_err(|error| format!("Google Gemini speech request failed: {error}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_message = read_api_error(response).await;

            if status.is_server_error() && attempt + 1 < GOOGLE_TTS_RETRY_COUNT {
                last_error = Some(format!(
                    "Google Gemini speech request failed: {error_message}"
                ));
                continue;
            }

            return Err(format!(
                "Google Gemini speech request failed: {error_message}"
            ));
        }

        let parsed = response
            .json::<GoogleGenerateContentResponse>()
            .await
            .map_err(|error| format!("Failed to parse Google Gemini speech response: {error}"))?;

        match extract_google_audio(parsed) {
            Ok((mime_type, audio_bytes)) => {
                return Ok(SynthesizedVoiceAudio {
                    provider: "google".to_string(),
                    mime_type,
                    audio_base64: BASE64_STANDARD.encode(audio_bytes),
                });
            }
            Err(error)
                if google_tts_failure_is_retryable(&error)
                    && attempt + 1 < GOOGLE_TTS_RETRY_COUNT =>
            {
                last_error = Some(error.into_message());
            }
            Err(error) => {
                return Err(error.into_message());
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        "Google Gemini speech synthesis failed without a specific error.".to_string()
    }))
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
    fn create_google_pace_instruction_skips_defaultish_rates() {
        assert_eq!(create_google_pace_instruction(None), None);
        assert_eq!(create_google_pace_instruction(Some(f64::INFINITY)), None);
        assert_eq!(create_google_pace_instruction(Some(1.03)), None);
    }

    #[test]
    fn create_google_pace_instruction_describes_faster_and_slower_rates() {
        assert_eq!(
            create_google_pace_instruction(Some(1.25)),
            Some("Keep the spoken delivery brisk at roughly 1.25x normal pace.".to_string())
        );
        assert_eq!(
            create_google_pace_instruction(Some(0.8)),
            Some(
                "Keep the spoken delivery calm and slightly slower at roughly 0.80x normal pace."
                    .to_string()
            )
        );
    }

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

    #[test]
    fn google_tts_failure_is_retryable_only_for_retryable_extraction_failures() {
        assert!(google_tts_failure_is_retryable(
            &GoogleAudioExtractionFailure::Retryable("try again".to_string())
        ));
        assert!(!google_tts_failure_is_retryable(
            &GoogleAudioExtractionFailure::NonRetryable("invalid audio".to_string())
        ));
    }
}
