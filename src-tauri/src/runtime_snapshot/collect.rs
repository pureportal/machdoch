use std::collections::HashMap;

use super::settings::{UserConfigFile, WorkspaceConfigFile};
use super::{
    env::{has_configured_value, load_workspace_env, resolve_agent_cli_binary},
    settings::{normalize_user_agent_limits_settings, normalize_user_review_model_settings},
    user_config::load_user_config_file,
    workspace::{load_workspace_config, resolve_workspace_root_path},
    ProviderAvailability, RuntimeAgentLimits, RuntimeCompatibilityConfig, RuntimeReviewModelConfig,
    RuntimeSnapshot, RuntimeWebSearchConfig, WebSearchProviderAvailability,
};
use super::{normalize_optional_string, AudioProviderAvailability};
use crate::runtime_contract_generated::{
    AGENT_CLI_PROVIDERS, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_MODEL_PROVIDER, PROVIDER_ENV_KEYS,
    REASONING_MODES, USER_AUDIO_AI_PROVIDERS, VALID_AUDIO_AI_PROVIDERS, VALID_MODEL_PROVIDERS,
    VALID_WEB_SEARCH_PROVIDERS, WEB_SEARCH_ENV_KEYS,
};

fn resolve_runtime_agent_limits(
    user_config: &UserConfigFile,
    workspace_config: &WorkspaceConfigFile,
    env: &HashMap<String, String>,
) -> RuntimeAgentLimits {
    let user_settings = normalize_user_agent_limits_settings(&user_config.agent_limits);
    let configured_limits = workspace_config.agent_limits.as_ref();
    let mut infinite = user_settings.infinite;
    let mut executor_turns = user_settings.executor_turns;
    let mut autopilot_executor_iterations = user_settings.autopilot_executor_iterations;

    if let Some(configured_limits) = configured_limits {
        if let Some(configured_infinite) = configured_limits.infinite {
            infinite = configured_infinite;
        }

        if let Some(configured_executor_turns) = configured_limits.executor_turns {
            infinite = false;
            executor_turns = super::settings::clamp_executor_turn_limit(configured_executor_turns);
        }

        if let Some(configured_autopilot_iterations) =
            configured_limits.autopilot_executor_iterations
        {
            infinite = false;
            autopilot_executor_iterations =
                super::settings::clamp_autopilot_iteration_limit(configured_autopilot_iterations);
        }
    }

    if matches!(
        env.get("MACHDOCH_INFINITE").map(String::as_str),
        Some("true" | "1")
    ) {
        infinite = true;
    }

    if let Some(value) = env
        .get("MACHDOCH_EXECUTOR_TURNS")
        .and_then(|value| value.trim().parse::<u32>().ok())
    {
        infinite = false;
        executor_turns = super::settings::clamp_executor_turn_limit(value);
    }

    if let Some(value) = env
        .get("MACHDOCH_AUTOPILOT_ITERATIONS")
        .and_then(|value| value.trim().parse::<u32>().ok())
    {
        infinite = false;
        autopilot_executor_iterations = super::settings::clamp_autopilot_iteration_limit(value);
    }

    RuntimeAgentLimits {
        executor_turns: if infinite { None } else { Some(executor_turns) },
        autopilot_executor_iterations: if infinite {
            None
        } else {
            Some(autopilot_executor_iterations)
        },
    }
}

pub(super) fn get_provider_availability(
    env: &HashMap<String, String>,
) -> Vec<ProviderAvailability> {
    let mut availability = PROVIDER_ENV_KEYS
        .iter()
        .map(|(provider, env_key)| ProviderAvailability {
            provider: provider.to_string(),
            configured: has_configured_value(env.get(*env_key).map(String::as_str)),
        })
        .collect::<Vec<_>>();

    availability.extend(
        AGENT_CLI_PROVIDERS
            .iter()
            .map(|provider| ProviderAvailability {
                provider: provider.to_string(),
                configured: resolve_agent_cli_binary(provider, env).is_some(),
            }),
    );

    availability
}

pub(super) fn get_web_search_provider_availability(
    env: &HashMap<String, String>,
) -> Vec<WebSearchProviderAvailability> {
    WEB_SEARCH_ENV_KEYS
        .iter()
        .map(|(provider, env_key)| WebSearchProviderAvailability {
            provider: provider.to_string(),
            configured: has_configured_value(env.get(*env_key).map(String::as_str)),
        })
        .collect()
}

pub(super) fn get_audio_provider_availability(
    env: &HashMap<String, String>,
) -> Vec<AudioProviderAvailability> {
    USER_AUDIO_AI_PROVIDERS
        .iter()
        .filter_map(|provider| {
            let env_key = PROVIDER_ENV_KEYS
                .iter()
                .find_map(|(entry_provider, env_key)| {
                    if entry_provider == provider {
                        Some(*env_key)
                    } else {
                        None
                    }
                })?;

            Some(AudioProviderAvailability {
                provider: provider.to_string(),
                configured: has_configured_value(env.get(env_key).map(String::as_str)),
            })
        })
        .collect()
}

pub(super) fn resolve_audio_active_provider(configured_provider: Option<&str>) -> String {
    normalize_optional_string(configured_provider)
        .filter(|provider| is_valid_audio_ai_provider(provider))
        .unwrap_or_else(|| "none".to_string())
}

fn resolve_provider(
    configured_provider: Option<&str>,
    availability: &[ProviderAvailability],
) -> String {
    if let Some(provider) = normalize_optional_string(configured_provider) {
        if is_valid_model_provider(&provider) {
            return provider;
        }
    }

    availability
        .iter()
        .find(|entry| entry.configured)
        .map(|entry| entry.provider.clone())
        .unwrap_or_else(|| "unconfigured".to_string())
}

fn default_model_for_provider(provider: &str) -> &'static str {
    let normalized_provider = if provider == "unconfigured" {
        DEFAULT_MODEL_PROVIDER
    } else {
        provider
    };

    DEFAULT_MODEL_BY_PROVIDER
        .iter()
        .find_map(|(entry_provider, model)| {
            if *entry_provider == normalized_provider {
                Some(*model)
            } else {
                None
            }
        })
        .unwrap_or(DEFAULT_MODEL_BY_PROVIDER[0].1)
}

pub(super) fn resolve_web_search_active_provider(
    configured_provider: Option<&str>,
    env: &HashMap<String, String>,
) -> String {
    if let Some(provider) = normalize_optional_string(
        env.get("MACHDOCH_WEB_SEARCH_PROVIDER")
            .map(String::as_str)
            .or(configured_provider),
    ) {
        if is_valid_web_search_provider(&provider) {
            return provider;
        }
    }

    "none".to_string()
}

pub(super) fn is_valid_model_provider(value: &str) -> bool {
    VALID_MODEL_PROVIDERS.contains(&value)
}

pub(super) fn is_valid_web_search_provider(value: &str) -> bool {
    VALID_WEB_SEARCH_PROVIDERS.contains(&value)
}

pub(super) fn is_valid_audio_ai_provider(value: &str) -> bool {
    VALID_AUDIO_AI_PROVIDERS.contains(&value)
}

pub(super) fn is_valid_mode(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .is_some_and(|value| crate::runtime_contract_generated::RUN_MODES.contains(&value))
}

pub(super) fn is_valid_reasoning_mode(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .is_some_and(|value| REASONING_MODES.contains(&value))
}

fn resolve_compatibility(config: &WorkspaceConfigFile) -> RuntimeCompatibilityConfig {
    RuntimeCompatibilityConfig {
        discover_github_customizations: config
            .compatibility
            .as_ref()
            .and_then(|entry| entry.discover_github_customizations)
            .unwrap_or(false),
    }
}

pub(super) fn collect_runtime_snapshot(workspace_root: &str) -> Result<RuntimeSnapshot, String> {
    let workspace_path = resolve_workspace_root_path(workspace_root)?;
    let resolved_workspace_root = workspace_path.display().to_string();

    let env = load_workspace_env(&workspace_path)?;
    let (config, workspace_config_path) = load_workspace_config(&workspace_path)?;
    let (user_config, _) = load_user_config_file()?;
    let provider_availability = get_provider_availability(&env);
    let web_search_provider_availability = get_web_search_provider_availability(&env);
    let web_search_active_provider =
        resolve_web_search_active_provider(user_config.web_search.active_provider.as_deref(), &env);

    let default_mode = if is_valid_mode(config.default_mode.as_deref()) {
        config
            .default_mode
            .as_deref()
            .unwrap_or("machdoch")
            .trim()
            .to_string()
    } else {
        "machdoch".to_string()
    };
    let default_reasoning = if is_valid_reasoning_mode(config.reasoning.as_deref()) {
        config
            .reasoning
            .as_deref()
            .unwrap_or("default")
            .trim()
            .to_string()
    } else {
        "default".to_string()
    };
    let mode = if is_valid_mode(env.get("MACHDOCH_MODE").map(String::as_str)) {
        env.get("MACHDOCH_MODE")
            .map(String::as_str)
            .unwrap_or("machdoch")
            .trim()
            .to_string()
    } else {
        default_mode.clone()
    };

    let provider = resolve_provider(config.provider.as_deref(), &provider_availability);

    let model = normalize_optional_string(
        config
            .model
            .as_deref()
            .or(env.get("MACHDOCH_MODEL").map(String::as_str)),
    )
    .unwrap_or_else(|| default_model_for_provider(&provider).to_string());

    let reasoning = if is_valid_reasoning_mode(env.get("MACHDOCH_REASONING").map(String::as_str)) {
        env.get("MACHDOCH_REASONING")
            .map(String::as_str)
            .unwrap_or("default")
            .trim()
            .to_string()
    } else if is_valid_reasoning_mode(config.reasoning.as_deref()) {
        default_reasoning.clone()
    } else {
        "default".to_string()
    };

    let offline = matches!(
        env.get("MACHDOCH_OFFLINE").map(String::as_str),
        Some("true")
    ) || config.offline.unwrap_or(false);
    let review_model = normalize_user_review_model_settings(&user_config.review_model);

    Ok(RuntimeSnapshot {
        workspace_root: resolved_workspace_root,
        workspace_config_path,
        default_mode,
        default_reasoning,
        mode,
        provider,
        model,
        reasoning,
        offline,
        agent_limits: resolve_runtime_agent_limits(&user_config, &config, &env),
        compatibility: resolve_compatibility(&config),
        provider_availability,
        web_search: RuntimeWebSearchConfig {
            active_provider: web_search_active_provider,
            provider_availability: web_search_provider_availability,
        },
        review_model: RuntimeReviewModelConfig {
            mode: review_model.mode,
            provider: review_model.provider,
            model: review_model.model,
        },
        ui_control: crate::ui_control::detect_ui_control_availability(),
    })
}
