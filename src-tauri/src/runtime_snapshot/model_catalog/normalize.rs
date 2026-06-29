use super::super::normalize_optional_string;

pub(super) fn sanitize_provider_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "Provider model discovery timed out.".to_string();
    }

    if let Some(status) = error.status() {
        return format!("Provider model discovery returned HTTP {status}.");
    }

    "Provider model discovery failed before a response was received.".to_string()
}

pub(super) fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .and_then(|entry| normalize_optional_string(Some(entry)))
}

pub(super) fn json_u64(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key).and_then(serde_json::Value::as_u64)
}

pub(super) fn json_date_prefix(value: &serde_json::Value, key: &str) -> Option<String> {
    let raw = json_string(value, key)?;
    let date = raw.get(..10)?;
    let bytes = date.as_bytes();
    let looks_like_date = bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && date
            .chars()
            .enumerate()
            .all(|(index, character)| index == 4 || index == 7 || character.is_ascii_digit());

    looks_like_date.then(|| date.to_string())
}

pub(super) fn unix_seconds_to_utc_date(seconds: u64) -> Option<String> {
    let days = i64::try_from(seconds / 86_400).ok()?;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };

    if month <= 2 {
        year += 1;
    }

    Some(format!("{year:04}-{month:02}-{day:02}"))
}

pub(super) fn json_bool_from_keys(
    value: Option<&serde_json::Value>,
    keys: &[&str],
) -> Option<bool> {
    let object = value?.as_object()?;

    for key in keys {
        if let Some(value) = object.get(*key).and_then(serde_json::Value::as_bool) {
            return Some(value);
        }
    }

    None
}

pub(super) fn looks_like_dated_snapshot(model_id: &str) -> bool {
    if model_id.len() >= 10 {
        let tail = &model_id[model_id.len() - 10..];
        let bytes = tail.as_bytes();
        let is_hyphenated_date = bytes.get(4) == Some(&b'-')
            && bytes.get(7) == Some(&b'-')
            && tail
                .chars()
                .enumerate()
                .all(|(index, character)| index == 4 || index == 7 || character.is_ascii_digit());

        if is_hyphenated_date {
            return true;
        }
    }

    let Some(tail) = model_id.rsplit('-').next() else {
        return false;
    };

    tail.len() == 8 && tail.chars().all(|character| character.is_ascii_digit())
}

pub(super) fn is_openai_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if looks_like_dated_snapshot(&normalized) {
        return false;
    }

    if [
        "embedding",
        "moderation",
        "chatgpt",
        "codex",
        "computer-use",
        "dall",
        "image",
        "realtime",
        "search",
        "sora",
        "tts",
        "transcribe",
        "whisper",
    ]
    .iter()
    .any(|excluded| normalized.contains(excluded))
    {
        return false;
    }

    let Some(suffix) = normalized.strip_prefix("gpt-") else {
        return false;
    };
    let mut parts = suffix.split('-');
    let Some(version) = parts.next() else {
        return false;
    };
    let valid_version = !version.is_empty()
        && version
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
        && version.chars().any(|character| character.is_ascii_digit());

    if !valid_version {
        return false;
    }

    match parts.next() {
        None => true,
        Some("mini" | "nano") => parts.next().is_none(),
        Some(_) => false,
    }
}

pub(super) fn is_anthropic_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if normalized.contains("deprecated") {
        return false;
    }

    let parts = normalized.split('-').collect::<Vec<_>>();

    matches!(
        parts.as_slice(),
        ["claude", "opus" | "sonnet" | "haiku", "4", minor]
            if minor.chars().all(|character| character.is_ascii_digit())
    ) || matches!(
        parts.as_slice(),
        ["claude", "opus" | "sonnet" | "haiku", "4", minor, date]
            if minor.chars().all(|character| character.is_ascii_digit())
                && date.len() == 8
                && date.chars().all(|character| character.is_ascii_digit())
    ) || matches!(
        parts.as_slice(),
        ["claude", "4", minor, "opus" | "sonnet" | "haiku"]
            if minor.chars().all(|character| character.is_ascii_digit())
    )
}

pub(super) fn is_google_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if !normalized.starts_with("gemini-") || looks_like_dated_snapshot(&normalized) {
        return false;
    }

    if [
        "aqa",
        "audio",
        "banana",
        "customtools",
        "embedding",
        "gemma",
        "imagen",
        "image",
        "learnlm",
        "live",
        "lyria",
        "tts",
        "veo",
    ]
    .iter()
    .any(|excluded| normalized.contains(excluded))
    {
        return false;
    }

    let Some(suffix) = normalized.strip_prefix("gemini-") else {
        return false;
    };
    let parts = suffix.split('-').collect::<Vec<_>>();
    let Some(version) = parts.first() else {
        return false;
    };
    let valid_version = !version.is_empty()
        && version
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
        && version.chars().any(|character| character.is_ascii_digit());

    if !valid_version {
        return false;
    }

    match parts.as_slice() {
        [_, "pro" | "flash"] => true,
        [_, "pro" | "flash", "preview"] => true,
        [_, "flash", "lite"] => true,
        [_, "flash", "lite", "preview"] => true,
        _ => false,
    }
}

pub(super) fn runtime_model_stage(model_id: &str) -> Option<String> {
    let normalized = model_id.to_ascii_lowercase();

    if normalized.contains("deprecated") {
        return Some("deprecated".to_string());
    }

    if normalized.contains("preview") {
        return Some("preview".to_string());
    }

    None
}
