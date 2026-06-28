use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde::Deserialize;

const GOOGLE_PCM_SAMPLE_RATE_HZ: u32 = 24_000;
const GOOGLE_PCM_CHANNELS: u16 = 1;
const GOOGLE_PCM_BITS_PER_SAMPLE: u16 = 16;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GoogleGenerateContentResponse {
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

#[derive(Clone, Copy)]
enum GoogleResponseKind {
    Speech,
    Transcription,
}

impl GoogleResponseKind {
    fn blocked_message(self, block_reason: String) -> String {
        match self {
            Self::Speech => format!("Google Gemini speech request was blocked: {block_reason}."),
            Self::Transcription => {
                format!("Google Gemini speech-to-text request was blocked: {block_reason}.")
            }
        }
    }

    fn no_candidates_message(self) -> &'static str {
        match self {
            Self::Speech => "Google Gemini returned no speech candidates.",
            Self::Transcription => "Google Gemini returned no transcription candidates.",
        }
    }

    fn stopped_message(self, finish_reason: &str) -> String {
        match self {
            Self::Speech => {
                format!("Google Gemini speech request ended with {finish_reason}.")
            }
            Self::Transcription => {
                format!("Google Gemini speech-to-text request ended with {finish_reason}.")
            }
        }
    }
}

fn extract_google_candidate(
    response: GoogleGenerateContentResponse,
    kind: GoogleResponseKind,
) -> Result<GoogleCandidate, String> {
    if let Some(prompt_feedback) = response.prompt_feedback {
        if let Some(block_reason) = prompt_feedback.block_reason {
            return Err(kind.blocked_message(block_reason));
        }
    }

    let Some(candidate) = response
        .candidates
        .and_then(|candidates| candidates.into_iter().next())
    else {
        return Err(kind.no_candidates_message().to_string());
    };

    if let Some(finish_reason) = candidate.finish_reason.clone() {
        if matches!(finish_reason.as_str(), "SAFETY" | "PROHIBITED_CONTENT") {
            return Err(candidate
                .finish_message
                .unwrap_or_else(|| kind.stopped_message(&finish_reason)));
        }
    }

    Ok(candidate)
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

pub(super) fn extract_google_audio(
    response: GoogleGenerateContentResponse,
) -> Result<(String, Vec<u8>), String> {
    let candidate = extract_google_candidate(response, GoogleResponseKind::Speech)?;
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

pub(super) fn extract_google_transcript(
    response: GoogleGenerateContentResponse,
) -> Result<String, String> {
    let candidate = extract_google_candidate(response, GoogleResponseKind::Transcription)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn response_with_candidate(candidate: GoogleCandidate) -> GoogleGenerateContentResponse {
        GoogleGenerateContentResponse {
            candidates: Some(vec![candidate]),
            prompt_feedback: None,
        }
    }

    fn candidate_with_parts(parts: Vec<GooglePart>) -> GoogleCandidate {
        GoogleCandidate {
            content: Some(GoogleContent { parts }),
            finish_reason: None,
            finish_message: None,
        }
    }

    #[test]
    fn extract_google_transcript_joins_trimmed_text_parts() {
        let response = response_with_candidate(candidate_with_parts(vec![
            GooglePart {
                inline_data: None,
                text: Some("  open ".to_string()),
            },
            GooglePart {
                inline_data: None,
                text: Some("".to_string()),
            },
            GooglePart {
                inline_data: None,
                text: Some(" file.rs  ".to_string()),
            },
        ]));

        let transcript = extract_google_transcript(response).expect("expected transcript");

        assert_eq!(transcript, "open\nfile.rs");
    }

    #[test]
    fn extract_google_transcript_keeps_safety_finish_message() {
        let response = response_with_candidate(GoogleCandidate {
            content: None,
            finish_reason: Some("SAFETY".to_string()),
            finish_message: Some("blocked by policy".to_string()),
        });

        let error = extract_google_transcript(response).expect_err("expected safety error");

        assert_eq!(error, "blocked by policy");
    }

    #[test]
    fn extract_google_audio_wraps_pcm_bytes_as_wav() {
        let response = response_with_candidate(candidate_with_parts(vec![GooglePart {
            inline_data: Some(GoogleInlineData {
                mime_type: Some("audio/pcm".to_string()),
                data: BASE64_STANDARD.encode([1, 0, 2, 0]),
            }),
            text: None,
        }]));

        let (mime_type, audio) = extract_google_audio(response).expect("expected audio");

        assert_eq!(mime_type, "audio/wav");
        assert_eq!(&audio[0..4], b"RIFF");
        assert_eq!(&audio[8..12], b"WAVE");
        assert_eq!(&audio[40..44], &4u32.to_le_bytes());
        assert_eq!(&audio[44..], &[1, 0, 2, 0]);
    }
}
