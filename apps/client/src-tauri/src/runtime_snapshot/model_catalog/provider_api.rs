use std::collections::{HashMap, HashSet};

use super::{
    normalize::sanitize_provider_error,
    provider_api_types::{
        parse_anthropic_model_catalog as parse_anthropic_model_catalog_payload,
        parse_google_model_catalog as parse_google_model_catalog_payload,
        parse_langdock_model_catalog as parse_langdock_model_catalog_payload,
        parse_openai_model_catalog as parse_openai_model_catalog_payload,
        resolve_langdock_api_base_url, resolve_langdock_base_url, sorted_unique_runtime_models,
        LangdockApiFamily,
    },
    ProviderRuntimeModel,
};

pub(super) fn parse_langdock_model_catalog(raw: &str) -> Result<Vec<ProviderRuntimeModel>, String> {
    parse_langdock_model_catalog_payload(raw)
}

pub(super) fn finish_langdock_model_catalog(
    mut models: Vec<ProviderRuntimeModel>,
    errors: Vec<String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    if models.is_empty() {
        return Err(format!(
            "Langdock model discovery failed for all documented completion model APIs: {}",
            errors.join("; ")
        ));
    }

    if !errors.is_empty() {
        let warning = format!("Langdock model discovery is partial: {}", errors.join("; "));

        for model in &mut models {
            model.warnings.push(warning.clone());
        }
    }

    Ok(sorted_unique_runtime_models(models))
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
    let mut models = Vec::new();
    let mut errors = Vec::new();
    let openai_url = format!("{}/models", resolve_langdock_base_url(env));
    let anthropic_url = format!(
        "{}/models",
        resolve_langdock_api_base_url(env, LangdockApiFamily::Anthropic)
    );
    let google_url = format!(
        "{}/models",
        resolve_langdock_api_base_url(env, LangdockApiFamily::Google)
    );

    match fetch_langdock_text_model_catalog(client, api_key, &openai_url).await {
        Ok(raw) => match parse_langdock_model_catalog(&raw) {
            Ok(mut endpoint_models) if !endpoint_models.is_empty() => {
                models.append(&mut endpoint_models)
            }
            Ok(_) => errors.push("OpenAI-compatible endpoint returned no models.".to_string()),
            Err(error) => errors.push(format!("OpenAI-compatible endpoint: {error}")),
        },
        Err(error) => errors.push(format!("OpenAI-compatible endpoint: {error}")),
    }

    match fetch_langdock_anthropic_model_catalog(client, api_key, &anthropic_url).await {
        Ok(mut endpoint_models) if !endpoint_models.is_empty() => {
            models.append(&mut endpoint_models)
        }
        Ok(_) => errors.push("Anthropic endpoint returned no models.".to_string()),
        Err(error) => errors.push(format!("Anthropic endpoint: {error}")),
    }

    match fetch_langdock_google_model_catalog(client, api_key, &google_url).await {
        Ok(mut endpoint_models) if !endpoint_models.is_empty() => {
            models.append(&mut endpoint_models)
        }
        Ok(_) => errors.push("Google endpoint returned no models.".to_string()),
        Err(error) => errors.push(format!("Google endpoint: {error}")),
    }

    finish_langdock_model_catalog(models, errors)
}

async fn fetch_langdock_text_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
) -> Result<String, String> {
    client
        .get(url)
        .bearer_auth(api_key)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .text()
        .await
        .map_err(|error| format!("Failed to read Langdock model list: {error}"))
}

async fn fetch_langdock_anthropic_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let mut models = Vec::new();
    let mut after_id: Option<String> = None;
    let mut seen_after_ids = HashSet::new();

    loop {
        let mut request = client
            .get(url)
            .bearer_auth(api_key)
            .query(&[("limit", "1000")]);

        if let Some(after_id) = after_id.as_deref() {
            request = request.query(&[("after_id", after_id)]);
        }

        let payload = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(sanitize_provider_error)?
            .json::<serde_json::Value>()
            .await
            .map_err(|error| format!("Failed to parse Langdock Anthropic model list: {error}"))?;

        models.append(&mut parse_anthropic_model_catalog_payload(&payload));

        if payload.get("has_more").and_then(serde_json::Value::as_bool) != Some(true) {
            break;
        }

        let last_id = payload
            .get("last_id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "Langdock Anthropic model response requested another page without last_id."
                    .to_string()
            })?;

        if !seen_after_ids.insert(last_id.to_string()) {
            return Err("Langdock Anthropic model pagination repeated last_id.".to_string());
        }

        after_id = Some(last_id.to_string());
    }

    Ok(sorted_unique_runtime_models(models))
}

async fn fetch_langdock_google_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
    url: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let mut models = Vec::new();
    let mut page_token: Option<String> = None;
    let mut seen_page_tokens = HashSet::new();

    loop {
        let mut request = client
            .get(url)
            .bearer_auth(api_key)
            .query(&[("pageSize", "1000")]);

        if let Some(page_token) = page_token.as_deref() {
            request = request.query(&[("pageToken", page_token)]);
        }

        let payload = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(sanitize_provider_error)?
            .json::<serde_json::Value>()
            .await
            .map_err(|error| format!("Failed to parse Langdock Google model list: {error}"))?;

        models.append(&mut parse_google_model_catalog_payload(&payload));

        let Some(next_page_token) = payload
            .get("nextPageToken")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            break;
        };

        if !seen_page_tokens.insert(next_page_token.to_string()) {
            return Err("Langdock Google model pagination repeated nextPageToken.".to_string());
        }

        page_token = Some(next_page_token.to_string());
    }

    Ok(sorted_unique_runtime_models(models))
}

pub(super) async fn fetch_anthropic_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let mut models = Vec::new();
    let mut after_id: Option<String> = None;
    let mut seen_after_ids = HashSet::new();

    loop {
        let mut request = client
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .query(&[("limit", "1000")]);

        if let Some(after_id) = after_id.as_deref() {
            request = request.query(&[("after_id", after_id)]);
        }

        let payload = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(sanitize_provider_error)?
            .json::<serde_json::Value>()
            .await
            .map_err(|error| format!("Failed to parse Anthropic model list: {error}"))?;

        models.append(&mut parse_anthropic_model_catalog_payload(&payload));

        let has_more = payload
            .get("has_more")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        if !has_more {
            break;
        }

        let Some(last_id) = payload
            .get("last_id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        else {
            return Err(
                "Anthropic model discovery response requested another page without last_id."
                    .to_string(),
            );
        };

        if !seen_after_ids.insert(last_id.clone()) {
            return Err("Anthropic model pagination repeated last_id.".to_string());
        }

        after_id = Some(last_id);
    }

    Ok(sorted_unique_runtime_models(models))
}

pub(super) async fn fetch_google_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let mut models = Vec::new();
    let mut page_token: Option<String> = None;
    let mut seen_page_tokens = HashSet::new();

    loop {
        let mut request = client
            .get("https://generativelanguage.googleapis.com/v1beta/models")
            .query(&[("key", api_key), ("pageSize", "1000")]);

        if let Some(page_token) = page_token.as_deref() {
            request = request.query(&[("pageToken", page_token)]);
        }

        let payload = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(sanitize_provider_error)?
            .json::<serde_json::Value>()
            .await
            .map_err(|error| format!("Failed to parse Google model list: {error}"))?;

        models.append(&mut parse_google_model_catalog_payload(&payload));

        let Some(next_page_token) = payload
            .get("nextPageToken")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        else {
            break;
        };

        if !seen_page_tokens.insert(next_page_token.clone()) {
            return Err("Google model pagination repeated nextPageToken.".to_string());
        }

        page_token = Some(next_page_token);
    }

    Ok(sorted_unique_runtime_models(models))
}
