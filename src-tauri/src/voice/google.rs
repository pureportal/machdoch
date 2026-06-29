use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use reqwest::Client;
use serde_json::json;

use super::{
    common::{
        get_required_api_key, normalize_language_code, read_api_error, validate_audio_upload_size,
    },
    google_response::{
        extract_google_audio, extract_google_transcript, GoogleGenerateContentResponse,
    },
    SynthesizedVoiceAudio, TranscribedSpeechText,
};

const GOOGLE_TTS_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent";
const GOOGLE_STT_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
const GOOGLE_TTS_VOICE: &str = "Kore";
const GOOGLE_TTS_RETRY_COUNT: usize = 2;
const GOOGLE_STT_SYSTEM_INSTRUCTION: &str = "You are a speech-to-text transcription service for a desktop AI assistant. Return only the spoken transcript as plain text. Preserve punctuation, filenames, CLI flags, code symbols, and product names when they are clear. If no intelligible speech is present, return an empty transcript. Do not summarize, explain, or add speaker labels.";
const GOOGLE_MAX_INLINE_AUDIO_BYTES: usize = 20 * 1024 * 1024;

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

fn create_google_transcription_prompt(language_code: Option<&str>) -> String {
    if let Some(language_code) = normalize_language_code(language_code) {
        return format!(
            "Generate an accurate transcript of the spoken audio. The most likely spoken language code is {language_code}. If no intelligible speech is present, return an empty transcript. Return only the transcript text."
        );
    }

    "Generate an accurate transcript of the spoken audio. If no intelligible speech is present, return an empty transcript. Return only the transcript text."
        .to_string()
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
            Err(error) if attempt + 1 < GOOGLE_TTS_RETRY_COUNT => {
                last_error = Some(error);
            }
            Err(error) => {
                return Err(error);
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
) -> Result<TranscribedSpeechText, String> {
    validate_audio_upload_size(audio_bytes.len(), "Google", GOOGLE_MAX_INLINE_AUDIO_BYTES)?;

    let api_key = get_required_api_key(env, "GOOGLE_API_KEY", "Google")?;
    let request_body = json!({
        "systemInstruction": {
            "parts": [
                {
                    "text": GOOGLE_STT_SYSTEM_INSTRUCTION
                }
            ]
        },
        "contents": [
            {
                "parts": [
                    {
                        "text": create_google_transcription_prompt(language_code)
                    },
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": BASE64_STANDARD.encode(audio_bytes)
                        }
                    }
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "text/plain",
            "temperature": 0.1
        }
    });

    let response = client
        .post(GOOGLE_STT_ENDPOINT)
        .query(&[("key", api_key.as_str())])
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
        .json::<GoogleGenerateContentResponse>()
        .await
        .map_err(|error| {
            format!("Failed to parse Google Gemini speech-to-text response: {error}")
        })?;
    let transcript = extract_google_transcript(parsed)?;

    Ok(TranscribedSpeechText {
        provider: "google".to_string(),
        text: transcript,
        mime_type: mime_type.to_string(),
        detected_language: normalize_language_code(language_code),
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
    fn create_google_transcription_prompt_includes_normalized_language_hint() {
        let prompt = create_google_transcription_prompt(Some(" de-DE "));

        assert!(prompt.contains("de-DE"));
    }
}
