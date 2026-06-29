use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use reqwest::Client;
use serde::Deserialize;

use crate::runtime_snapshot::normalize_optional_string;

#[derive(Debug, Deserialize)]
struct ApiErrorEnvelope {
    error: ApiErrorBody,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    message: String,
}

pub(super) fn normalize_text(value: &str) -> Result<String, String> {
    let normalized = value.trim();

    if normalized.is_empty() {
        return Err("Expected non-empty text to synthesize.".to_string());
    }

    Ok(normalized.to_string())
}

pub(super) fn normalize_mime_type(value: &str) -> Result<String, String> {
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

pub(super) fn decode_audio_base64(value: &str) -> Result<Vec<u8>, String> {
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

pub(super) fn normalize_language_code(value: Option<&str>) -> Option<String> {
    normalize_optional_string(value)
}

pub(super) fn create_upload_filename(mime_type: &str) -> String {
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

pub(super) fn validate_audio_upload_size(
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

pub(super) fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))
}

pub(super) async fn read_api_error(response: reqwest::Response) -> String {
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

pub(super) fn get_required_api_key(
    env: &std::collections::HashMap<String, String>,
    key_name: &str,
    provider_label: &str,
) -> Result<String, String> {
    normalize_optional_string(env.get(key_name).map(String::as_str))
        .ok_or_else(|| format!("{provider_label} is not configured. Save an API key first."))
}
