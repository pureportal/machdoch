use std::{collections::HashMap, path::Path, time::Duration};

use github_copilot_sdk::{CliProgram, Client, ClientOptions, Model};

use super::super::normalize_optional_string;
use super::{resolve_agent_cli_binary, ProviderRuntimeModel, ProviderRuntimeModelCapabilities};

const COPILOT_SDK_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
const COPILOT_SDK_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const CANONICAL_REASONING_MODES: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

fn create_copilot_cli_runtime_model_base(model_id: &str) -> ProviderRuntimeModel {
    let normalized = model_id.to_ascii_lowercase();
    let mut recommended_for = vec!["coding".to_string()];

    if normalized.contains("haiku") || normalized.contains("flash") || normalized.contains("mini") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    } else if normalized.contains("sonnet") || normalized.contains("gpt-5.2") {
        recommended_for.push("fast".to_string());
    }

    ProviderRuntimeModel {
        id: normalized,
        label: None,
        stage: Some("stable".to_string()),
        release_date: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(false),
            tool_use: Some(true),
            reasoning: Some(true),
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
        warnings: vec![
            "Model availability depends on GitHub Copilot plan and organization policy."
                .to_string(),
        ],
        source: "provider-sdk".to_string(),
    }
}

fn positive_i64_to_u64(value: Option<i64>) -> Option<u64> {
    value
        .filter(|number| *number > 0)
        .and_then(|number| u64::try_from(number).ok())
}

fn total_context_tokens(prompt_tokens: Option<i64>, output_tokens: Option<i64>) -> Option<u64> {
    let prompt_tokens = positive_i64_to_u64(prompt_tokens)?;
    let output_tokens = positive_i64_to_u64(output_tokens).unwrap_or(0);

    prompt_tokens.checked_add(output_tokens)
}

fn normalize_reasoning_modes(model: &Model) -> Option<Vec<String>> {
    if model
        .capabilities
        .supports
        .as_ref()
        .and_then(|supports| supports.reasoning_effort)
        == Some(false)
    {
        return Some(vec!["default".to_string()]);
    }

    let mut modes = vec!["default".to_string()];

    if let Some(supported) = model.supported_reasoning_efforts.as_ref() {
        for mode in supported {
            let normalized = mode.trim().to_ascii_lowercase();

            if CANONICAL_REASONING_MODES.contains(&normalized.as_str())
                && !modes.contains(&normalized)
            {
                modes.push(normalized);
            }
        }
    }

    if let Some(default) = model
        .default_reasoning_effort
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|mode| CANONICAL_REASONING_MODES.contains(&mode.as_str()))
    {
        if !modes.contains(&default) {
            modes.push(default);
        }
    }

    Some(modes)
}

pub(super) fn create_copilot_cli_runtime_model(model: &Model) -> Option<ProviderRuntimeModel> {
    let id = normalize_optional_string(Some(model.id.as_str()))?.to_ascii_lowercase();
    let label = normalize_optional_string(Some(model.name.as_str()));
    let supports = model.capabilities.supports.as_ref();
    let limits = model.capabilities.limits.as_ref();
    let token_prices = model
        .billing
        .as_ref()
        .and_then(|billing| billing.token_prices.as_ref());
    let max_output_tokens = limits.and_then(|entry| entry.max_output_tokens);
    let reasoning_modes = normalize_reasoning_modes(model);
    let default_reasoning_mode = model
        .default_reasoning_effort
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|mode| CANONICAL_REASONING_MODES.contains(&mode.as_str()))
        .filter(|mode| {
            reasoning_modes
                .as_ref()
                .is_some_and(|supported| supported.contains(mode))
        });
    let mut runtime_model = create_copilot_cli_runtime_model_base(&id);

    runtime_model.label = label;
    runtime_model.capabilities.image_input = supports.and_then(|entry| entry.vision);
    runtime_model.capabilities.reasoning = supports.and_then(|entry| entry.reasoning_effort);
    runtime_model.capabilities.context_window_tokens = limits
        .and_then(|entry| positive_i64_to_u64(entry.max_context_window_tokens))
        .or_else(|| {
            total_context_tokens(
                token_prices.and_then(|prices| prices.max_prompt_tokens),
                max_output_tokens,
            )
        });
    runtime_model.capabilities.long_context_window_tokens = token_prices
        .and_then(|prices| prices.long_context.as_ref())
        .and_then(|long_context| {
            total_context_tokens(long_context.max_prompt_tokens, max_output_tokens)
        });
    runtime_model.capabilities.max_output_tokens = positive_i64_to_u64(max_output_tokens);
    runtime_model.capabilities.reasoning_modes = reasoning_modes;
    runtime_model.capabilities.default_reasoning_mode = default_reasoning_mode;
    runtime_model.capabilities.supported_image_media_types = runtime_model
        .capabilities
        .image_input
        .filter(|supported| *supported)
        .and_then(|_| limits.and_then(|entry| entry.vision.as_ref()))
        .map(|vision| vision.supported_media_types.clone());
    Some(runtime_model)
}

async fn stop_copilot_sdk_client(client: &Client) {
    if !matches!(
        tokio::time::timeout(COPILOT_SDK_SHUTDOWN_TIMEOUT, client.stop()).await,
        Ok(Ok(()))
    ) {
        client.force_stop();
    }
}

async fn fetch_copilot_cli_sdk_model_catalog(
    binary: &Path,
    env: &HashMap<String, String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let mut child_env = env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Vec<_>>();
    child_env.push(("NO_COLOR".to_string(), "1".to_string()));

    let options = ClientOptions::new()
        .with_program(CliProgram::Path(binary.to_path_buf()))
        .with_env(child_env);
    let discovery = async {
        let client = Client::start(options)
            .await
            .map_err(|error| format!("failed to start the Copilot SDK runtime: {error}"))?;
        let models = client
            .list_models()
            .await
            .map_err(|error| format!("Copilot SDK models.list failed: {error}"));

        stop_copilot_sdk_client(&client).await;
        models
    };
    let models = tokio::time::timeout(COPILOT_SDK_DISCOVERY_TIMEOUT, discovery)
        .await
        .map_err(|_| "Copilot SDK models.list timed out.".to_string())??;
    let runtime_models = models
        .iter()
        .filter_map(create_copilot_cli_runtime_model)
        .collect::<Vec<_>>();

    if runtime_models.is_empty() {
        return Err("Copilot SDK models.list returned no available models.".to_string());
    }

    Ok(runtime_models)
}

pub(super) async fn fetch_copilot_cli_model_catalog(
    env: &HashMap<String, String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let Some(binary) = resolve_agent_cli_binary("copilot-cli", env) else {
        return Err(
            "Copilot CLI binary was not found. Configure MACHDOCH_COPILOT_CLI_PATH or install `copilot` on PATH."
                .to_string(),
        );
    };

    fetch_copilot_cli_sdk_model_catalog(&binary, env).await
}
