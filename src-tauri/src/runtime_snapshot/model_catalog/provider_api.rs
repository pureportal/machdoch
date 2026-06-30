use std::collections::HashMap;

use super::{
    normalize::{
        is_anthropic_runtime_model, is_google_runtime_model, is_langdock_runtime_model,
        is_openai_runtime_model, json_bool_from_keys, json_date_prefix, json_string, json_u64,
        runtime_model_stage, sanitize_provider_error, unix_milliseconds_to_utc_date,
        unix_seconds_to_utc_date,
    },
    ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
};

fn create_openai_runtime_model(
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
        description: None,
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

fn create_anthropic_runtime_model(entry: &serde_json::Value) -> Option<ProviderRuntimeModel> {
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
        description: None,
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

fn create_google_runtime_model(entry: &serde_json::Value) -> Option<ProviderRuntimeModel> {
    let resource_name = json_string(entry, "name")?;
    let id = json_string(entry, "baseModelId").unwrap_or_else(|| {
        resource_name
            .strip_prefix("models/")
            .unwrap_or(resource_name.as_str())
            .to_string()
    });
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
        description: json_string(entry, "description"),
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
    let region = json_string(entry, "region");
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
        description: region.map(|value| format!("Langdock model available in region {value}.")),
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

pub(super) fn parse_langdock_model_catalog(
    raw: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|error| format!("Failed to parse Langdock model list: {error}"))?;
    let mut by_id = HashMap::<String, ProviderRuntimeModel>::new();

    if let Some(entries) = payload.get("data").and_then(serde_json::Value::as_array) {
        for model in entries.iter().filter_map(create_langdock_runtime_model) {
            if is_langdock_runtime_model(&model.id) {
                by_id.entry(model.id.clone()).or_insert(model);
            }
        }
    }

    let mut models = by_id.into_values().collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}

pub(super) async fn fetch_openai_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = client
        .get("https://api.openai.com/v1/models")
        .bearer_auth(api_key)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Failed to parse OpenAI model list: {error}"))?;
    let mut models = payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let id = json_string(entry, "id")?;

                    is_openai_runtime_model(&id).then(|| {
                        create_openai_runtime_model(
                            &id,
                            json_u64(entry, "created").and_then(unix_seconds_to_utc_date),
                        )
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}

pub(super) async fn fetch_langdock_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let raw = client
        .get("https://api.langdock.com/agent/v1/models")
        .bearer_auth(api_key)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .text()
        .await
        .map_err(|error| format!("Failed to read Langdock model list: {error}"))?;

    parse_langdock_model_catalog(&raw)
}

pub(super) async fn fetch_anthropic_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = client
        .get("https://api.anthropic.com/v1/models?limit=1000")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Failed to parse Anthropic model list: {error}"))?;
    let mut models = payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(create_anthropic_runtime_model)
                .filter(|model| is_anthropic_runtime_model(&model.id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}

pub(super) async fn fetch_google_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = client
        .get("https://generativelanguage.googleapis.com/v1beta/models")
        .query(&[("key", api_key), ("pageSize", "1000")])
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Failed to parse Google model list: {error}"))?;
    let mut by_id = HashMap::<String, ProviderRuntimeModel>::new();

    if let Some(entries) = payload.get("models").and_then(serde_json::Value::as_array) {
        for model in entries.iter().filter_map(create_google_runtime_model) {
            if is_google_runtime_model(&model.id) {
                by_id.entry(model.id.clone()).or_insert(model);
            }
        }
    }

    let mut models = by_id.into_values().collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}
