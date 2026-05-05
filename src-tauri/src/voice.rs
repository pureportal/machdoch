use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use reqwest::{multipart, Client};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::runtime_snapshot::normalize_optional_string;

const OPENAI_TTS_ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
const OPENAI_TTS_MODEL: &str = "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE: &str = "cedar";
const OPENAI_TTS_INSTRUCTIONS: &str =
    "Speak in a clear, friendly, helpful tone for a desktop AI assistant.";
const OPENAI_MAX_INPUT_CHARS: usize = 4096;
const OPENAI_STT_ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_STT_MODEL: &str = "gpt-4o-transcribe";
const OPENAI_STT_PROMPT: &str = "Transcribe this short push-to-talk instruction for a desktop AI assistant. Preserve punctuation, filenames, CLI flags, code symbols, and product names when they are clear. If no intelligible speech is present, return an empty transcript. Return only the transcript.";
const OPENAI_MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

const GOOGLE_TTS_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent";
const GOOGLE_STT_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
const GOOGLE_TTS_VOICE: &str = "Kore";
const GOOGLE_PCM_SAMPLE_RATE_HZ: u32 = 24_000;
const GOOGLE_PCM_CHANNELS: u16 = 1;
const GOOGLE_PCM_BITS_PER_SAMPLE: u16 = 16;
const GOOGLE_TTS_RETRY_COUNT: usize = 2;
const GOOGLE_STT_SYSTEM_INSTRUCTION: &str = "You are a speech-to-text transcription service for a desktop AI assistant. Return only the spoken transcript as plain text. Preserve punctuation, filenames, CLI flags, code symbols, and product names when they are clear. If no intelligible speech is present, return an empty transcript. Do not summarize, explain, or add speaker labels.";
const GOOGLE_MAX_INLINE_AUDIO_BYTES: usize = 20 * 1024 * 1024;

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

#[derive(Debug, Deserialize)]
struct ApiErrorEnvelope {
    error: ApiErrorBody,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    message: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
    language: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleGenerateContentResponse {
    candidates: Option<Vec<GoogleCandidate>>,
    prompt_feedback: Option<GooglePromptFeedback>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GooglePromptFeedback {
    block_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCandidate {
    content: Option<GoogleContent>,
    finish_reason: Option<String>,
    finish_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleContent {
    parts: Vec<GooglePart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GooglePart {
    inline_data: Option<GoogleInlineData>,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleInlineData {
    mime_type: Option<String>,
    data: String,
}

fn normalize_text(value: &str) -> Result<String, String> {
    let normalized = value.trim();

    if normalized.is_empty() {
        return Err("Expected non-empty text to synthesize.".to_string());
    }

    Ok(normalized.to_string())
}

fn normalize_mime_type(value: &str) -> Result<String, String> {
    let normalized = value
        .split(';')
        .next()
        .map(str::trim)
        .unwrap_or_default()
        .to_lowercase();

    if normalized.is_empty() || !normalized.starts_with("audio/") {
        return Err("Expected an audio MIME type.".to_string());
    }

    Ok(normalized)
}

fn decode_audio_base64(value: &str) -> Result<Vec<u8>, String> {
    let normalized = normalize_optional_string(Some(value))
        .ok_or_else(|| "Expected non-empty audio data.".to_string())?;
    let decoded = BASE64_STANDARD
        .decode(normalized)
        .map_err(|error| format!("Failed to decode audio payload: {error}"))?;

    if decoded.is_empty() {
        return Err("Expected non-empty audio data.".to_string());
    }

    Ok(decoded)
}

fn normalize_language_code(value: Option<&str>) -> Option<String> {
    normalize_optional_string(value)
}

fn create_upload_filename(mime_type: &str) -> String {
    let extension = match mime_type {
        "audio/wav" => "wav",
        "audio/webm" => "webm",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
        "audio/mp3" | "audio/mpeg" | "audio/mpga" => "mp3",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/aiff" => "aiff",
        "audio/aac" => "aac",
        _ => "bin",
    };

    format!("speech-input.{extension}")
}

fn validate_audio_upload_size(
    size_bytes: usize,
    provider_label: &str,
    max_size_bytes: usize,
) -> Result<(), String> {
    if size_bytes > max_size_bytes {
        let max_size_mb = max_size_bytes / (1024 * 1024);
        return Err(format!(
            "{provider_label} speech-to-text uploads are limited to {max_size_mb} MB. Record a shorter clip and try again."
        ));
    }

    Ok(())
}

fn clamp_openai_speed(value: Option<f64>) -> f64 {
    let Some(value) = value.filter(|value| value.is_finite()) else {
        return 1.0;
    };

    value.clamp(0.25, 4.0)
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

fn create_google_transcription_prompt(language_code: Option<&str>) -> String {
    if let Some(language_code) = normalize_language_code(language_code) {
        return format!(
            "Generate an accurate transcript of the spoken audio. The most likely spoken language code is {language_code}. If no intelligible speech is present, return an empty transcript. Return only the transcript text."
        );
    }

    "Generate an accurate transcript of the spoken audio. If no intelligible speech is present, return an empty transcript. Return only the transcript text."
        .to_string()
}

fn create_wav_from_pcm_mono_16bit_24khz(pcm_bytes: &[u8]) -> Vec<u8> {
    let data_len = pcm_bytes.len() as u32;
    let byte_rate = GOOGLE_PCM_SAMPLE_RATE_HZ
        * GOOGLE_PCM_CHANNELS as u32
        * (GOOGLE_PCM_BITS_PER_SAMPLE as u32 / 8);
    let block_align = GOOGLE_PCM_CHANNELS * (GOOGLE_PCM_BITS_PER_SAMPLE / 8);
    let chunk_size = 36 + data_len;

    let mut wav = Vec::with_capacity(44 + pcm_bytes.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&chunk_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&GOOGLE_PCM_CHANNELS.to_le_bytes());
    wav.extend_from_slice(&GOOGLE_PCM_SAMPLE_RATE_HZ.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&GOOGLE_PCM_BITS_PER_SAMPLE.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm_bytes);
    wav
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))
}

async fn read_api_error(response: reqwest::Response) -> String {
    let status = response.status();
    let raw_body = response.text().await.unwrap_or_default();

    if let Ok(parsed) = serde_json::from_str::<ApiErrorEnvelope>(&raw_body) {
        return format!("{status}: {}", parsed.error.message);
    }

    if raw_body.trim().is_empty() {
        return format!("{status}");
    }

    format!("{status}: {}", raw_body.trim())
}

fn get_required_api_key(
    env: &std::collections::HashMap<String, String>,
    key_name: &str,
    provider_label: &str,
) -> Result<String, String> {
    normalize_optional_string(env.get(key_name).map(String::as_str))
        .ok_or_else(|| format!("{provider_label} is not configured. Save an API key first."))
}

async fn synthesize_openai(
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

fn extract_google_audio(
    response: GoogleGenerateContentResponse,
) -> Result<(String, Vec<u8>), String> {
    if let Some(prompt_feedback) = response.prompt_feedback {
        if let Some(block_reason) = prompt_feedback.block_reason {
            return Err(format!(
                "Google Gemini speech request was blocked: {block_reason}."
            ));
        }
    }

    let Some(candidate) = response
        .candidates
        .and_then(|candidates| candidates.into_iter().next())
    else {
        return Err("Google Gemini returned no speech candidates.".to_string());
    };

    if let Some(finish_reason) = candidate.finish_reason.as_deref() {
        match finish_reason {
            "SAFETY" | "PROHIBITED_CONTENT" => {
                return Err(candidate.finish_message.unwrap_or_else(|| {
                    format!("Google Gemini speech request ended with {finish_reason}.")
                }));
            }
            _ => {}
        }
    }

    let Some(content) = candidate.content else {
        return Err("Google Gemini returned no audio content.".to_string());
    };

    let Some(inline_data) = content.parts.into_iter().find_map(|part| part.inline_data) else {
        return Err("Google Gemini returned a response without inline audio data.".to_string());
    };

    let mime_type = inline_data
        .mime_type
        .unwrap_or_else(|| "audio/pcm".to_string());
    let decoded = BASE64_STANDARD
        .decode(inline_data.data)
        .map_err(|error| format!("Failed to decode Google Gemini audio: {error}"))?;

    if mime_type.contains("wav") {
        return Ok(("audio/wav".to_string(), decoded));
    }

    Ok((
        "audio/wav".to_string(),
        create_wav_from_pcm_mono_16bit_24khz(&decoded),
    ))
}

fn extract_google_transcript(response: GoogleGenerateContentResponse) -> Result<String, String> {
    if let Some(prompt_feedback) = response.prompt_feedback {
        if let Some(block_reason) = prompt_feedback.block_reason {
            return Err(format!(
                "Google Gemini speech-to-text request was blocked: {block_reason}."
            ));
        }
    }

    let Some(candidate) = response
        .candidates
        .and_then(|candidates| candidates.into_iter().next())
    else {
        return Err("Google Gemini returned no transcription candidates.".to_string());
    };

    if let Some(finish_reason) = candidate.finish_reason.as_deref() {
        match finish_reason {
            "SAFETY" | "PROHIBITED_CONTENT" => {
                return Err(candidate.finish_message.unwrap_or_else(|| {
                    format!("Google Gemini speech-to-text request ended with {finish_reason}.")
                }));
            }
            _ => {}
        }
    }

    let Some(content) = candidate.content else {
        return Err("Google Gemini returned no transcription content.".to_string());
    };

    let transcript = content
        .parts
        .into_iter()
        .filter_map(|part| part.text)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if transcript.is_empty() {
        return Err("Google Gemini returned an empty transcript.".to_string());
    }

    Ok(transcript)
}

async fn synthesize_google(
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

async fn transcribe_openai(
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

async fn transcribe_google(
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
        "openai" => synthesize_openai(&client, &env, &normalized_text, rate).await,
        "google" => {
            synthesize_google(
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
            transcribe_openai(
                &client,
                &env,
                audio_bytes,
                &normalized_mime_type,
                language_code.as_deref(),
            )
            .await
        }
        "google" => {
            transcribe_google(
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
