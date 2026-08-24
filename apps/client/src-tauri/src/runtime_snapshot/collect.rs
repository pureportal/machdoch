use std::collections::HashMap;

use super::{
    env::{has_configured_value, load_workspace_env, resolve_agent_cli_binary},
    settings::{normalize_user_agent_limits_settings, normalize_user_review_model_settings},
    settings_types::{ContextWindow, ReasoningExecutionMode, UserConfigFile, WorkspaceConfigFile},
    user_config::load_user_config_file,
    workspace::{load_workspace_config, resolve_workspace_root_path},
    ProviderAvailability, RuntimeAgentLimits, RuntimeCompatibilityConfig, RuntimeReviewModelConfig,
    RuntimeSnapshot, RuntimeWebSearchConfig, WebSearchProviderAvailability,
};
use super::{normalize_optional_string, AudioProviderAvailability};
use crate::runtime_contract_generated::{
    AGENT_CLI_PROVIDERS, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_MODEL_PROVIDER,
    MAX_CONTEXT_WINDOW_TOKENS, MIN_CONTEXT_WINDOW_TOKENS, PROVIDER_ENV_KEYS, REASONING_MODES,
    USER_AUDIO_AI_PROVIDERS, VALID_AUDIO_AI_PROVIDERS, VALID_MODEL_PROVIDERS,
    VALID_WEB_SEARCH_PROVIDERS, WEB_SEARCH_ENV_KEYS,
};

fn normalize_context_window(value: &ContextWindow) -> Result<ContextWindow, String> {
    match value {
        ContextWindow::Mode(mode) if matches!(mode.trim(), "default" | "long") => {
            Ok(ContextWindow::Mode(mode.trim().to_string()))
        }
        ContextWindow::Tokens(tokens)
            if (*tokens >= MIN_CONTEXT_WINDOW_TOKENS) && (*tokens <= MAX_CONTEXT_WINDOW_TOKENS) =>
        {
            Ok(ContextWindow::Tokens(*tokens))
        }
        _ => Err(
            "Context window must be default, long, or a positive token count up to 10000000."
                .to_string(),
        ),
    }
}

fn parse_context_window(value: &str) -> Result<ContextWindow, String> {
    let normalized = value.trim().to_ascii_lowercase();

    if matches!(normalized.as_str(), "default" | "long") {
        return Ok(ContextWindow::Mode(normalized));
    }

    normalized
        .parse::<u32>()
        .ok()
        .map(ContextWindow::Tokens)
        .as_ref()
        .map(normalize_context_window)
        .transpose()?
        .ok_or_else(|| {
            "Context window must be default, long, or a positive token count up to 10000000."
                .to_string()
        })
}

fn parse_reasoning_execution_mode(value: &str) -> Result<ReasoningExecutionMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "standard" => Ok(ReasoningExecutionMode::Standard),
        "pro" => Ok(ReasoningExecutionMode::Pro),
        _ => Err("Reasoning mode must be standard or pro.".to_string()),
    }
}

fn is_date_suffix(value: &str) -> bool {
    value.len() == 11
        && value.starts_with('-')
        && value.as_bytes()[5] == b'-'
        && value.as_bytes()[8] == b'-'
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| matches!(index, 0 | 5 | 8) || character.is_ascii_digit())
}

fn openai_model_supports_pro_mode(provider: &str, model: &str) -> bool {
    if provider != "openai" {
        return false;
    }

    let normalized = model.trim().to_ascii_lowercase();

    ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
        .iter()
        .any(|base| {
            normalized
                .strip_prefix(base)
                .is_some_and(|suffix| suffix.is_empty() || is_date_suffix(suffix))
        })
}

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
        .filter(|(provider, _)| VALID_MODEL_PROVIDERS.contains(provider))
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
    let default_reasoning = match normalize_optional_string(config.reasoning.as_deref()) {
        Some(value) if is_valid_reasoning_mode(Some(value.as_str())) => value,
        Some(value) => {
            return Err(format!(
                "Invalid workspace reasoning mode '{value}'. Expected one of: {}.",
                REASONING_MODES.join(", ")
            ));
        }
        None => "default".to_string(),
    };
    let default_context_window = config
        .context_window
        .as_ref()
        .map(normalize_context_window)
        .transpose()?
        .unwrap_or_else(|| ContextWindow::Mode("default".to_string()));
    let default_reasoning_mode = config
        .reasoning_mode
        .clone()
        .unwrap_or(ReasoningExecutionMode::Standard);
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
        env.get("MACHDOCH_MODEL")
            .map(String::as_str)
            .or(config.model.as_deref()),
    )
    .unwrap_or_else(|| default_model_for_provider(&provider).to_string());

    let reasoning =
        match normalize_optional_string(env.get("MACHDOCH_REASONING").map(String::as_str)) {
            Some(value) if is_valid_reasoning_mode(Some(value.as_str())) => value,
            Some(value) => {
                return Err(format!(
                    "MACHDOCH_REASONING has unsupported value '{value}'. Expected one of: {}.",
                    REASONING_MODES.join(", ")
                ));
            }
            None => default_reasoning.clone(),
        };
    let context_window = env
        .get("MACHDOCH_CONTEXT_WINDOW")
        .map(String::as_str)
        .map(parse_context_window)
        .transpose()?
        .unwrap_or_else(|| default_context_window.clone());
    let reasoning_mode = env
        .get("MACHDOCH_REASONING_MODE")
        .map(String::as_str)
        .map(parse_reasoning_execution_mode)
        .transpose()?
        .unwrap_or_else(|| default_reasoning_mode.clone());

    if matches!(reasoning_mode, ReasoningExecutionMode::Pro)
        && !openai_model_supports_pro_mode(&provider, &model)
    {
        return Err(format!(
            "Reasoning execution mode `pro` is not supported by `{model}` on `{provider}`."
        ));
    }

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
        default_reasoning_mode,
        default_context_window,
        mode,
        provider,
        model,
        reasoning,
        reasoning_mode,
        context_window,
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    use std::{
        env as std_env, fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();

        std_env::temp_dir().join(format!("machdoch-collect-{name}-{unique}"))
    }

    fn create_file(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("test directory should be creatable");
        }

        fs::write(path, "").expect("test binary should be writable");
    }

    fn set_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path)
            .expect("test file metadata should be readable")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("test file should be made executable");
    }

    fn provider_is_configured(provider: &str, env: &HashMap<String, String>) -> bool {
        get_provider_availability(env)
            .into_iter()
            .find(|entry| entry.provider == provider)
            .expect("provider availability should include requested provider")
            .configured
    }

    #[test]
    fn provider_availability_rejects_non_executable_unix_cli_path() {
        let directory = temp_test_directory("provider-non-executable");
        let binary_path = directory.join("codex");
        create_file(&binary_path);

        let env = HashMap::from([(
            "MACHDOCH_CODEX_CLI_PATH".to_string(),
            binary_path.display().to_string(),
        )]);

        assert!(!provider_is_configured("codex-cli", &env));

        set_executable(&binary_path);

        assert!(provider_is_configured("codex-cli", &env));

        let _ = fs::remove_dir_all(directory);
    }
}
