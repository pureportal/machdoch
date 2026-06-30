use std::{collections::HashMap, time::Duration};

use super::{
    env::{has_configured_value, resolve_agent_cli_binary},
    ProviderModelCatalogProvider,
};
use codex_cli::fetch_codex_cli_model_catalog;
use copilot_cli::fetch_copilot_cli_model_catalog;
use provider_api::{
    fetch_anthropic_model_catalog, fetch_google_model_catalog, fetch_langdock_model_catalog,
    fetch_openai_model_catalog,
};

mod codex_cli;
mod command;
mod copilot_cli;
mod normalize;
mod provider_api;
#[cfg(test)]
mod tests;

pub(super) use super::{ProviderRuntimeModel, ProviderRuntimeModelCapabilities};

pub(super) fn create_provider_model_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("Failed to create provider model HTTP client: {error}"))
}

fn provider_model_catalog_unavailable(provider: &str, error: &str) -> ProviderModelCatalogProvider {
    ProviderModelCatalogProvider {
        provider: provider.to_string(),
        source: "provider-probe".to_string(),
        available: false,
        error: Some(error.to_string()),
        models: Vec::new(),
    }
}

pub(super) async fn fetch_provider_model_catalog(
    client: &reqwest::Client,
    env: &HashMap<String, String>,
    provider: &str,
) -> ProviderModelCatalogProvider {
    let (api_key_name, fetch_result) = match provider {
        "openai" => {
            let api_key = env.get("OPENAI_API_KEY").map(String::as_str);
            match api_key.filter(|value| has_configured_value(Some(value))) {
                Some(value) => (
                    "OPENAI_API_KEY",
                    fetch_openai_model_catalog(client, value).await,
                ),
                None => {
                    return provider_model_catalog_unavailable(
                        provider,
                        "OPENAI_API_KEY is not configured.",
                    );
                }
            }
        }
        "anthropic" => {
            let api_key = env.get("ANTHROPIC_API_KEY").map(String::as_str);
            match api_key.filter(|value| has_configured_value(Some(value))) {
                Some(value) => (
                    "ANTHROPIC_API_KEY",
                    fetch_anthropic_model_catalog(client, value).await,
                ),
                None => {
                    return provider_model_catalog_unavailable(
                        provider,
                        "ANTHROPIC_API_KEY is not configured.",
                    );
                }
            }
        }
        "google" => {
            let api_key = env.get("GOOGLE_API_KEY").map(String::as_str);
            match api_key.filter(|value| has_configured_value(Some(value))) {
                Some(value) => (
                    "GOOGLE_API_KEY",
                    fetch_google_model_catalog(client, value).await,
                ),
                None => {
                    return provider_model_catalog_unavailable(
                        provider,
                        "GOOGLE_API_KEY is not configured.",
                    );
                }
            }
        }
        "langdock" => {
            let api_key = env.get("LANGDOCK_API_KEY").map(String::as_str);
            match api_key.filter(|value| has_configured_value(Some(value))) {
                Some(value) => (
                    "LANGDOCK_API_KEY",
                    fetch_langdock_model_catalog(client, value).await,
                ),
                None => {
                    return provider_model_catalog_unavailable(
                        provider,
                        "LANGDOCK_API_KEY is not configured.",
                    );
                }
            }
        }
        "codex-cli" => match fetch_codex_cli_model_catalog(env) {
            Ok(models) => {
                return ProviderModelCatalogProvider {
                    provider: provider.to_string(),
                    source: "provider-probe".to_string(),
                    available: true,
                    error: None,
                    models,
                };
            }
            Err(error) => {
                return provider_model_catalog_unavailable(provider, &error);
            }
        },
        "copilot-cli" => match fetch_copilot_cli_model_catalog(env) {
            Ok(models) => {
                return ProviderModelCatalogProvider {
                    provider: provider.to_string(),
                    source: "provider-probe".to_string(),
                    available: true,
                    error: None,
                    models,
                };
            }
            Err(error) => {
                return provider_model_catalog_unavailable(provider, &error);
            }
        },
        "claude-cli" => {
            return provider_model_catalog_unavailable(
                provider,
                "Model catalog discovery is delegated to the external CLI and is not queried by Machdoch.",
            );
        }
        _ => {
            return provider_model_catalog_unavailable(provider, "Unsupported provider.");
        }
    };

    match fetch_result {
        Ok(models) => ProviderModelCatalogProvider {
            provider: provider.to_string(),
            source: "provider-api".to_string(),
            available: true,
            error: None,
            models,
        },
        Err(error) => provider_model_catalog_unavailable(
            provider,
            &format!("{api_key_name} is configured, but {error}"),
        ),
    }
}
