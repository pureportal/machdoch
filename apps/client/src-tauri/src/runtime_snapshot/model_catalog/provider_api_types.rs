use std::collections::HashMap;

use super::{
    normalize::{
        is_anthropic_runtime_model, is_google_runtime_model, is_langdock_runtime_model,
        is_openai_runtime_model, json_date_prefix, json_string, json_u64, runtime_model_stage,
        unix_seconds_to_utc_date,
    },
    ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
};

const LANGDOCK_DEFAULT_REGION: &str = "eu";
const LANGDOCK_SUPPORTED_REGIONS: [&str; 2] = ["eu", "us"];
const ANTHROPIC_IMAGE_MEDIA_TYPES: [&str; 4] =
    ["image/gif", "image/jpeg", "image/png", "image/webp"];
const CANONICAL_REASONING_MODES: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

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

fn capability_supported(capabilities: Option<&serde_json::Value>, key: &str) -> Option<bool> {
    let capability = capabilities?.get(key)?;

    capability.as_bool().or_else(|| {
        capability
            .get("supported")
            .and_then(serde_json::Value::as_bool)
    })
}

fn combine_capability_support(left: Option<bool>, right: Option<bool>) -> Option<bool> {
    if left == Some(true) || right == Some(true) {
        return Some(true);
    }

    if left == Some(false) || right == Some(false) {
        return Some(false);
    }

    None
}

fn positive_json_u64_from_keys(entry: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| json_u64(entry, key).filter(|value| *value > 0))
}

fn canonical_reasoning_modes(capability: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let capability = capability?;

    if capability
        .get("supported")
        .and_then(serde_json::Value::as_bool)
        == Some(false)
    {
        return Some(vec!["default".to_string()]);
    }

    if capability
        .get("supported")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return None;
    }

    let mut modes = vec!["default".to_string()];

    for mode in CANONICAL_REASONING_MODES {
        if capability
            .get(mode)
            .and_then(|entry| entry.get("supported"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            modes.push(mode.to_string());
        }
    }

    Some(modes)
}

fn array_capability_contains(
    entry: &serde_json::Value,
    keys: &[&str],
    accepted_values: &[&str],
) -> Option<bool> {
    for key in keys {
        let Some(values) = entry.get(*key).and_then(serde_json::Value::as_array) else {
            continue;
        };

        return Some(
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|value| {
                    accepted_values
                        .iter()
                        .any(|accepted| value.eq_ignore_ascii_case(accepted))
                }),
        );
    }

    None
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
        .filter(|value| LANGDOCK_SUPPORTED_REGIONS.contains(&value.as_str()))
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
    ProviderRuntimeModel {
        id: model_id.to_string(),
        label: None,
        stage: runtime_model_stage(model_id),
        release_date,
        recommended_for: Vec::new(),
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: None,
            tool_use: None,
            reasoning: None,
            streaming: None,
            context_window_tokens: None,
            long_context_window_tokens: None,
            max_output_tokens: None,
            reasoning_modes: None,
            default_reasoning_mode: None,
            supported_image_media_types: None,
            voice: None,
            computer_use: None,
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
    let image_input = capability_supported(capabilities, "image_input")
        .or_else(|| capability_supported(capabilities, "imageInput"));
    let tool_use = capability_supported(capabilities, "tool_use")
        .or_else(|| capability_supported(capabilities, "toolUse"));
    let thinking = capability_supported(capabilities, "thinking");
    let effort = capabilities.and_then(|value| value.get("effort"));
    let effort_supported = capability_supported(capabilities, "effort");
    let reasoning_modes = canonical_reasoning_modes(effort);
    let reasoning = combine_capability_support(effort_supported, thinking);
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

    if image_input == Some(true) {
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
            image_input,
            tool_use,
            reasoning,
            streaming: Some(true),
            context_window_tokens: positive_json_u64_from_keys(
                entry,
                &["max_input_tokens", "maxInputTokens"],
            ),
            long_context_window_tokens: None,
            max_output_tokens: positive_json_u64_from_keys(entry, &["max_tokens", "maxTokens"]),
            reasoning_modes,
            default_reasoning_mode: None,
            supported_image_media_types: image_input.filter(|supported| *supported).map(|_| {
                ANTHROPIC_IMAGE_MEDIA_TYPES
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            }),
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
    let methods = [
        "supportedGenerationMethods",
        "supportedActions",
        "supported_generation_methods",
        "supported_actions",
    ]
    .into_iter()
    .find_map(|key| entry.get(key).and_then(serde_json::Value::as_array))
    .map(|methods| {
        methods
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();

    if !methods
        .iter()
        .any(|method| method.eq_ignore_ascii_case("generateContent"))
    {
        return None;
    }

    let image_input = array_capability_contains(
        entry,
        &[
            "inputModalities",
            "supportedInputModalities",
            "input_modalities",
        ],
        &["image", "IMAGE"],
    )
    .or(Some(true));
    let reasoning = entry.get("thinking").and_then(serde_json::Value::as_bool);
    let mut recommended_for = Vec::new();

    if reasoning == Some(true) {
        recommended_for.push("coding".to_string());
    }

    if image_input == Some(true) {
        recommended_for.push("vision".to_string());
    }

    Some(ProviderRuntimeModel {
        id,
        label: json_string(entry, "displayName").or_else(|| json_string(entry, "display_name")),
        stage: runtime_model_stage(&resource_name),
        release_date: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input,
            tool_use: None,
            reasoning,
            streaming: Some(true),
            context_window_tokens: positive_json_u64_from_keys(
                entry,
                &["inputTokenLimit", "input_token_limit"],
            ),
            long_context_window_tokens: None,
            max_output_tokens: positive_json_u64_from_keys(
                entry,
                &["outputTokenLimit", "output_token_limit"],
            ),
            reasoning_modes: None,
            default_reasoning_mode: None,
            supported_image_media_types: image_input.filter(|supported| *supported).map(|_| {
                [
                    "image/heic",
                    "image/heif",
                    "image/jpeg",
                    "image/png",
                    "image/webp",
                ]
                .into_iter()
                .map(str::to_string)
                .collect()
            }),
            voice: None,
            computer_use: None,
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    })
}

fn create_langdock_runtime_model(entry: &serde_json::Value) -> Option<ProviderRuntimeModel> {
    let id = json_string(entry, "id")?;
    let normalized = id.to_ascii_lowercase();
    let reasoning = entry
        .get("supportsExtendedThinking")
        .and_then(serde_json::Value::as_bool);
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

    Some(ProviderRuntimeModel {
        id,
        label: None,
        stage: runtime_model_stage(&normalized),
        release_date: json_u64(entry, "created")
            .filter(|seconds| *seconds > 0)
            .and_then(unix_seconds_to_utc_date),
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: None,
            tool_use: None,
            reasoning,
            streaming: Some(true),
            context_window_tokens: None,
            long_context_window_tokens: None,
            max_output_tokens: None,
            reasoning_modes: None,
            default_reasoning_mode: None,
            supported_image_media_types: None,
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

fn merge_runtime_model(existing: &mut ProviderRuntimeModel, incoming: ProviderRuntimeModel) {
    existing.label = incoming.label.or(existing.label.take());
    existing.stage = incoming.stage.or(existing.stage.take());
    existing.release_date = incoming.release_date.or(existing.release_date.take());

    for recommendation in incoming.recommended_for {
        if !existing.recommended_for.contains(&recommendation) {
            existing.recommended_for.push(recommendation);
        }
    }

    existing.capabilities.image_input = incoming
        .capabilities
        .image_input
        .or(existing.capabilities.image_input);
    existing.capabilities.tool_use = incoming
        .capabilities
        .tool_use
        .or(existing.capabilities.tool_use);
    existing.capabilities.reasoning = incoming
        .capabilities
        .reasoning
        .or(existing.capabilities.reasoning);
    existing.capabilities.streaming = incoming
        .capabilities
        .streaming
        .or(existing.capabilities.streaming);
    existing.capabilities.context_window_tokens = incoming
        .capabilities
        .context_window_tokens
        .or(existing.capabilities.context_window_tokens);
    existing.capabilities.long_context_window_tokens = incoming
        .capabilities
        .long_context_window_tokens
        .or(existing.capabilities.long_context_window_tokens);
    existing.capabilities.max_output_tokens = incoming
        .capabilities
        .max_output_tokens
        .or(existing.capabilities.max_output_tokens);
    existing.capabilities.reasoning_modes = incoming
        .capabilities
        .reasoning_modes
        .or_else(|| existing.capabilities.reasoning_modes.take());
    existing.capabilities.default_reasoning_mode = incoming
        .capabilities
        .default_reasoning_mode
        .or_else(|| existing.capabilities.default_reasoning_mode.take());
    existing.capabilities.supported_image_media_types = incoming
        .capabilities
        .supported_image_media_types
        .or_else(|| existing.capabilities.supported_image_media_types.take());
    existing.capabilities.voice = incoming.capabilities.voice.or(existing.capabilities.voice);
    existing.capabilities.computer_use = incoming
        .capabilities
        .computer_use
        .or(existing.capabilities.computer_use);

    for warning in incoming.warnings {
        if !existing.warnings.contains(&warning) {
            existing.warnings.push(warning);
        }
    }
}

pub(super) fn sorted_unique_runtime_models(
    models: impl IntoIterator<Item = ProviderRuntimeModel>,
) -> Vec<ProviderRuntimeModel> {
    let mut by_id = HashMap::<String, ProviderRuntimeModel>::new();

    for model in models {
        by_id
            .entry(model.id.clone())
            .and_modify(|existing| merge_runtime_model(existing, model.clone()))
            .or_insert(model);
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
    json_u64(entry, "created")
        .filter(|seconds| *seconds > 0)
        .and_then(unix_seconds_to_utc_date)
}
