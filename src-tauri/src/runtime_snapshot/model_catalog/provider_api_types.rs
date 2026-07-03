use std::collections::HashMap;

use super::{
    normalize::{
        is_anthropic_runtime_model, is_google_runtime_model, is_langdock_runtime_model,
        is_openai_runtime_model, json_bool_from_keys, json_date_prefix, json_string, json_u64,
        runtime_model_stage, unix_milliseconds_to_utc_date, unix_seconds_to_utc_date,
    },
    ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
};

const LANGDOCK_DEFAULT_REGION: &str = "eu";
const LANGDOCK_SUPPORTED_REGIONS: [&str; 2] = ["eu", "us"];

#[derive(Clone, Copy)]
pub(super) enum LangdockApiFamily {
    Anthropic,
    Google,
    OpenAi,
}

fn strip_trailing_slashes(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

fn strip_known_langdock_endpoint_suffix(value: &str) -> String {
    let mut normalized = strip_trailing_slashes(value.trim());

    for suffix in ["/chat/completions", "/messages", "/fim/completions"] {
        if normalized
            .to_ascii_lowercase()
            .ends_with(&suffix.to_ascii_lowercase())
        {
            let new_len = normalized.len() - suffix.len();
            normalized.truncate(new_len);
            return strip_trailing_slashes(&normalized);
        }
    }

    let lower = normalized.to_ascii_lowercase();

    if let Some(models_index) = lower.rfind("/models") {
        let suffix = &lower[models_index..];

        if suffix == "/models"
            || (suffix.starts_with("/models/")
                && (suffix.ends_with(":generatecontent")
                    || suffix.ends_with(":streamgeneratecontent")))
        {
            normalized.truncate(models_index);
        }
    }

    strip_trailing_slashes(&normalized)
}

fn langdock_origin(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?;
    let port = url
        .port()
        .map(|value| format!(":{value}"))
        .unwrap_or_default();

    Some(format!("{}://{host}{port}", url.scheme()))
}

fn create_langdock_root(url: &reqwest::Url, root_segments: &[&str]) -> Option<String> {
    let origin = langdock_origin(url)?;

    if root_segments.is_empty() {
        return Some(origin);
    }

    Some(format!("{origin}/{}", root_segments.join("/")))
}

fn parse_langdock_configured_base_url(value: &str) -> Option<(String, Option<String>)> {
    let normalized = strip_known_langdock_endpoint_suffix(value);
    let url = reqwest::Url::parse(&normalized).ok()?;
    let segments = url
        .path()
        .trim_end_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    if segments.is_empty() {
        return Some((create_langdock_root(&url, &[])?, None));
    }

    if segments.as_slice() == ["api", "public"] {
        return Some((create_langdock_root(&url, &segments)?, None));
    }

    for (index, segment) in segments.iter().enumerate() {
        let protocol = segment.to_ascii_lowercase();
        let Some(region) = segments
            .get(index + 1)
            .map(|value| value.to_ascii_lowercase())
        else {
            continue;
        };

        if !["openai", "anthropic", "google", "mistral"].contains(&protocol.as_str()) {
            continue;
        }

        if !LANGDOCK_SUPPORTED_REGIONS
            .iter()
            .any(|supported_region| *supported_region == region)
        {
            continue;
        }

        return Some((
            create_langdock_root(&url, &segments[..index])?,
            Some(region),
        ));
    }

    None
}

fn resolve_langdock_region(env: &HashMap<String, String>) -> String {
    env.get("LANGDOCK_REGION")
        .map(String::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|value| {
            LANGDOCK_SUPPORTED_REGIONS
                .iter()
                .any(|region| *region == value.as_str())
        })
        .unwrap_or_else(|| LANGDOCK_DEFAULT_REGION.to_string())
}

fn append_langdock_api_path(root: &str, family: LangdockApiFamily, region: &str) -> String {
    let root = strip_trailing_slashes(root);

    match family {
        LangdockApiFamily::Anthropic => format!("{root}/anthropic/{region}/v1"),
        LangdockApiFamily::Google => format!("{root}/google/{region}/v1beta"),
        LangdockApiFamily::OpenAi => format!("{root}/openai/{region}/v1"),
    }
}

pub(super) fn resolve_langdock_api_base_url(
    env: &HashMap<String, String>,
    family: LangdockApiFamily,
) -> String {
    if let Some(base_url) = env
        .get("LANGDOCK_BASE_URL")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let normalized_base_url = strip_known_langdock_endpoint_suffix(base_url);

        if let Some((root, embedded_region)) =
            parse_langdock_configured_base_url(&normalized_base_url)
        {
            let region = embedded_region.unwrap_or_else(|| resolve_langdock_region(env));

            return append_langdock_api_path(&root, family, &region);
        }

        if matches!(family, LangdockApiFamily::OpenAi) {
            return normalized_base_url;
        }

        return append_langdock_api_path(
            &normalized_base_url,
            family,
            &resolve_langdock_region(env),
        );
    }

    append_langdock_api_path(
        "https://api.langdock.com",
        family,
        &resolve_langdock_region(env),
    )
}

pub(super) fn resolve_langdock_base_url(env: &HashMap<String, String>) -> String {
    resolve_langdock_api_base_url(env, LangdockApiFamily::OpenAi)
}

pub(super) fn create_openai_runtime_model(
    model_id: &str,
    release_date: Option<String>,
) -> ProviderRuntimeModel {
    let normalized = model_id.to_ascii_lowercase();
    let voice = false;
    let computer_use = normalized.starts_with("gpt-5.5") || normalized.starts_with("gpt-5.4");
    let latest_text_model = normalized.starts_with("gpt-5");
    let mut recommended_for = Vec::new();

    if latest_text_model {
        recommended_for.push("coding".to_string());
        recommended_for.push("vision".to_string());
    }

    if normalized.contains("mini") || normalized.contains("nano") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    }

    if voice {
        recommended_for.push("voice".to_string());
    }

    if computer_use {
        recommended_for.push("computer-use".to_string());
    }

    ProviderRuntimeModel {
        id: model_id.to_string(),
        label: None,
        stage: runtime_model_stage(model_id),
        release_date,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(latest_text_model),
            tool_use: Some(true),
            reasoning: Some(
                normalized.starts_with("gpt-5")
                    || normalized.starts_with('o')
                    || normalized.contains("reasoning"),
            ),
            streaming: Some(true),
            context_window_tokens: None,
            max_output_tokens: None,
            voice: Some(voice),
            computer_use: Some(computer_use),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    }
}

pub(super) fn create_anthropic_runtime_model(
    entry: &serde_json::Value,
) -> Option<ProviderRuntimeModel> {
    let id = json_string(entry, "id")?;
    let display_name =
        json_string(entry, "display_name").or_else(|| json_string(entry, "displayName"));
    let capabilities = entry.get("capabilities");
    let normalized = id.to_ascii_lowercase();
    let image_input = json_bool_from_keys(
        capabilities,
        &["vision", "image_input", "imageInput", "images"],
    )
    .unwrap_or(true);
    let tool_use = json_bool_from_keys(
        capabilities,
        &["tool_use", "toolUse", "function_calling", "functionCalling"],
    )
    .unwrap_or(true);
    let reasoning = json_bool_from_keys(
        capabilities,
        &[
            "reasoning",
            "thinking",
            "extended_thinking",
            "extendedThinking",
            "adaptive_thinking",
            "adaptiveThinking",
        ],
    )
    .unwrap_or_else(|| normalized.contains("opus") || normalized.contains("sonnet"));
    let mut recommended_for = Vec::new();

    if normalized.contains("opus") || normalized.contains("sonnet") {
        recommended_for.push("coding".to_string());
    }

    if normalized.contains("sonnet") || normalized.contains("haiku") {
        recommended_for.push("fast".to_string());
    }

    if normalized.contains("haiku") {
        recommended_for.push("cheap".to_string());
    }

    if image_input {
        recommended_for.push("vision".to_string());
    }

    Some(ProviderRuntimeModel {
        id: id.clone(),
        label: display_name,
        stage: runtime_model_stage(&id),
        release_date: json_date_prefix(entry, "created_at")
            .or_else(|| json_date_prefix(entry, "createdAt")),
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(image_input),
            tool_use: Some(tool_use),
            reasoning: Some(reasoning),
            streaming: Some(true),
            context_window_tokens: json_u64(entry, "max_input_tokens")
                .or_else(|| json_u64(entry, "maxInputTokens")),
            max_output_tokens: json_u64(entry, "max_tokens")
                .or_else(|| json_u64(entry, "maxTokens")),
            voice: Some(false),
            computer_use: Some(false),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    })
}

pub(super) fn create_google_runtime_model(
    entry: &serde_json::Value,
) -> Option<ProviderRuntimeModel> {
    let resource_name = json_string(entry, "name")?;
    let id = resource_name
        .strip_prefix("models/")
        .unwrap_or(resource_name.as_str())
        .to_string();
    let methods = entry
        .get("supportedGenerationMethods")
        .and_then(serde_json::Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if !methods.iter().any(|method| method == "generateContent") {
        return None;
    }

    let normalized = id.to_ascii_lowercase();
    let voice = normalized.contains("tts") || normalized.contains("audio");
    let image_input = !voice
        && !normalized.contains("embedding")
        && !normalized.contains("imagen")
        && !normalized.contains("veo");
    let reasoning = entry
        .get("thinking")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or_else(|| normalized.contains("pro") || normalized.contains("2.5"));
    let mut recommended_for = Vec::new();

    if reasoning || normalized.contains("pro") {
        recommended_for.push("coding".to_string());
    }

    if normalized.contains("flash") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    }

    if image_input {
        recommended_for.push("vision".to_string());
    }

    if voice {
        recommended_for.push("voice".to_string());
    }

    Some(ProviderRuntimeModel {
        id,
        label: json_string(entry, "displayName"),
        stage: runtime_model_stage(&resource_name),
        release_date: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(image_input),
            tool_use: Some(true),
            reasoning: Some(reasoning),
            streaming: Some(true),
            context_window_tokens: json_u64(entry, "inputTokenLimit"),
            max_output_tokens: json_u64(entry, "outputTokenLimit"),
            voice: Some(voice),
            computer_use: Some(false),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    })
}

fn create_langdock_runtime_model(entry: &serde_json::Value) -> Option<ProviderRuntimeModel> {
    let id = json_string(entry, "id")?;
    let normalized = id.to_ascii_lowercase();
    let supports_extended_thinking = entry
        .get("supportsExtendedThinking")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let image_input = normalized.starts_with("gpt-")
        || normalized.starts_with("claude-")
        || normalized.starts_with("gemini-");
    let reasoning = supports_extended_thinking
        || normalized.starts_with("gpt-")
        || normalized.starts_with('o')
        || normalized.starts_with("claude-")
        || normalized.starts_with("gemini-")
        || normalized.contains("reason")
        || normalized.contains("thinking");
    let mut recommended_for = Vec::new();

    if normalized.starts_with("gpt-")
        || normalized.starts_with("claude-")
        || normalized.starts_with("gemini-")
        || normalized.contains("codestral")
        || normalized.contains("deepseek")
        || normalized.contains("qwen")
    {
        recommended_for.push("coding".to_string());
    }

    if normalized.contains("mini")
        || normalized.contains("nano")
        || normalized.contains("flash")
        || normalized.contains("haiku")
        || normalized.contains("llama")
        || normalized.contains("ollama")
    {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    }

    if image_input {
        recommended_for.push("vision".to_string());
    }

    Some(ProviderRuntimeModel {
        id,
        label: None,
        stage: runtime_model_stage(&normalized),
        release_date: json_u64(entry, "created").and_then(unix_milliseconds_to_utc_date),
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(image_input),
            tool_use: Some(true),
            reasoning: Some(reasoning),
            streaming: Some(true),
            context_window_tokens: None,
            max_output_tokens: None,
            voice: Some(false),
            computer_use: Some(false),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    })
}

pub(super) fn sorted_runtime_models(
    mut models: Vec<ProviderRuntimeModel>,
) -> Vec<ProviderRuntimeModel> {
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models
}

pub(super) fn sorted_unique_runtime_models(
    models: impl IntoIterator<Item = ProviderRuntimeModel>,
) -> Vec<ProviderRuntimeModel> {
    let mut by_id = HashMap::<String, ProviderRuntimeModel>::new();

    for model in models {
        by_id.entry(model.id.clone()).or_insert(model);
    }

    sorted_runtime_models(by_id.into_values().collect())
}

pub(super) fn parse_openai_model_catalog(payload: &serde_json::Value) -> Vec<ProviderRuntimeModel> {
    payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let id = json_string(entry, "id")?;

                    is_openai_runtime_model(&id)
                        .then(|| create_openai_runtime_model(&id, openai_release_date(entry)))
                })
                .collect::<Vec<_>>()
        })
        .map(sorted_runtime_models)
        .unwrap_or_default()
}

pub(super) fn parse_anthropic_model_catalog(
    payload: &serde_json::Value,
) -> Vec<ProviderRuntimeModel> {
    payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(create_anthropic_runtime_model)
                .filter(|model| is_anthropic_runtime_model(&model.id))
                .collect::<Vec<_>>()
        })
        .map(sorted_runtime_models)
        .unwrap_or_default()
}

pub(super) fn parse_google_model_catalog(payload: &serde_json::Value) -> Vec<ProviderRuntimeModel> {
    payload
        .get("models")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            sorted_unique_runtime_models(
                entries
                    .iter()
                    .filter_map(create_google_runtime_model)
                    .filter(|model| is_google_runtime_model(&model.id)),
            )
        })
        .unwrap_or_default()
}

pub(super) fn parse_langdock_model_catalog(raw: &str) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|error| format!("Failed to parse Langdock model list: {error}"))?;

    Ok(payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            sorted_unique_runtime_models(
                entries
                    .iter()
                    .filter_map(create_langdock_runtime_model)
                    .filter(|model| is_langdock_runtime_model(&model.id)),
            )
        })
        .unwrap_or_default())
}

pub(super) fn openai_release_date(entry: &serde_json::Value) -> Option<String> {
    json_u64(entry, "created").and_then(unix_seconds_to_utc_date)
}
