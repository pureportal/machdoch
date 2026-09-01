use reqwest::Response;

pub(super) const MAX_ERROR_RESPONSE_BYTES: usize = 16 * 1024;

pub(super) enum ResponseBodyError {
    TooLarge,
    Read(reqwest::Error),
}

pub(super) async fn read_bounded_response(
    mut response: Response,
    limit: usize,
) -> Result<Vec<u8>, ResponseBodyError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ResponseBodyError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(ResponseBodyError::Read)? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(ResponseBodyError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub(super) async fn manager_response_error(response: Response, fallback: &str) -> String {
    let status = response.status();
    read_bounded_response(response, MAX_ERROR_RESPONSE_BYTES)
        .await
        .ok()
        .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok())
        .and_then(|value| {
            value
                .get("error")
                .and_then(serde_json::Value::as_str)
                .and_then(|message| normalized_manager_message(message, 500))
        })
        .unwrap_or_else(|| format!("{fallback} ({status})."))
}

pub(super) fn normalized_manager_message(value: &str, maximum_characters: usize) -> Option<String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || maximum_characters == 0
        || normalized.chars().any(is_unsafe_text_character)
    {
        return None;
    }
    Some(normalized.chars().take(maximum_characters).collect())
}

pub(super) fn is_unsafe_text_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{ad}'
                | '\u{600}'..='\u{605}'
                | '\u{61c}'
                | '\u{6dd}'
                | '\u{70f}'
                | '\u{890}'..='\u{891}'
                | '\u{8e2}'
                | '\u{180e}'
                | '\u{200b}'..='\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{206f}'
                | '\u{feff}'
                | '\u{fff9}'..='\u{fffb}'
                | '\u{110bd}'
                | '\u{110cd}'
                | '\u{13430}'..='\u{1343f}'
                | '\u{1bca0}'..='\u{1bca3}'
                | '\u{1d173}'..='\u{1d17a}'
                | '\u{e0001}'
                | '\u{e0020}'..='\u{e007f}'
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_messages_reject_terminal_and_directional_controls() {
        assert!(normalized_manager_message("\u{1b}[31mspoofed", 500).is_none());
        assert!(normalized_manager_message("safe\u{202e}txt", 500).is_none());
        assert_eq!(
            normalized_manager_message("  Connection rejected.  ", 500).as_deref(),
            Some("Connection rejected.")
        );
        assert_eq!(
            normalized_manager_message(&"🙂".repeat(501), 500)
                .expect("safe message should be retained")
                .chars()
                .count(),
            500
        );
    }
}
