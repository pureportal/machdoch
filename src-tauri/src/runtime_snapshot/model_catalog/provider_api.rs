use std::collections::HashMap;

use super::{
    normalize::sanitize_provider_error,
    provider_api_types::{
        parse_anthropic_model_catalog as parse_anthropic_model_catalog_payload,
        parse_google_model_catalog as parse_google_model_catalog_payload,
        parse_langdock_model_catalog as parse_langdock_model_catalog_payload,
        parse_openai_model_catalog as parse_openai_model_catalog_payload,
        resolve_langdock_base_url,
    },
    ProviderRuntimeModel,
};

pub(super) fn parse_langdock_model_catalog(raw: &str) -> Result<Vec<ProviderRuntimeModel>, String> {
    parse_langdock_model_catalog_payload(raw)
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

    Ok(parse_openai_model_catalog_payload(&payload))
}

pub(super) async fn fetch_langdock_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
    env: &HashMap<String, String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let url = format!("{}/models", resolve_langdock_base_url(env));
    let raw = client
        .get(url)
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

    Ok(parse_anthropic_model_catalog_payload(&payload))
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

    Ok(parse_google_model_catalog_payload(&payload))
}
