use std::{
    collections::HashMap,
    env as std_env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri_plugin_autostart::ManagerExt as _;

use crate::runtime_contract_generated::{
    AGENT_CLI_PROVIDERS, AGENT_CLI_PROVIDER_ENV_KEYS,
    DEFAULT_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    DEFAULT_DESKTOP_SETTING_ALWAYS_RUN_AS_ADMINISTRATOR,
    DEFAULT_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_ENABLED,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_HIDE_WHEN_FULLSCREEN,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    DEFAULT_DESKTOP_SETTING_AUTOSTART_MINIMIZED, DEFAULT_DESKTOP_SETTING_AUTOSTART_TO_TRAY,
    DEFAULT_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_ENABLED, DEFAULT_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS, DEFAULT_MODEL_BY_PROVIDER,
    DEFAULT_MODEL_PROVIDER, PROVIDER_ENV_KEYS, REASONING_MODES, USER_API_PROVIDERS,
    USER_AUDIO_AI_PROVIDERS, USER_WEB_SEARCH_PROVIDERS, VALID_AUDIO_AI_PROVIDERS,
    VALID_MODEL_PROVIDERS, VALID_WEB_SEARCH_PROVIDERS, WEB_SEARCH_ENV_KEYS,
};
use crate::ui_control::UiControlAvailability;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    workspace_root: String,
    workspace_config_path: Option<String>,
    active_profile: Option<String>,
    available_profiles: Vec<RuntimeProfileSummary>,
    default_mode: String,
    default_reasoning: String,
    mode: String,
    provider: String,
    model: String,
    reasoning: String,
    offline: bool,
    agent_limits: RuntimeAgentLimits,
    compatibility: RuntimeCompatibilityConfig,
    provider_availability: Vec<ProviderAvailability>,
    web_search: RuntimeWebSearchConfig,
    review_model: RuntimeReviewModelConfig,
    ui_control: UiControlAvailability,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCompatibilityConfig {
    discover_github_customizations: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAgentLimits {
    executor_turns: Option<u32>,
    autopilot_executor_iterations: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileSummary {
    name: String,
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAvailability {
    provider: String,
    configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCatalogSnapshot {
    generated_at: u64,
    providers: Vec<ProviderModelCatalogProvider>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCatalogProvider {
    provider: String,
    source: String,
    available: bool,
    error: Option<String>,
    models: Vec<ProviderRuntimeModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeModel {
    id: String,
    label: Option<String>,
    stage: Option<String>,
    release_date: Option<String>,
    description: Option<String>,
    recommended_for: Vec<String>,
    capabilities: ProviderRuntimeModelCapabilities,
    warnings: Vec<String>,
    source: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeModelCapabilities {
    image_input: Option<bool>,
    tool_use: Option<bool>,
    reasoning: Option<bool>,
    streaming: Option<bool>,
    context_window_tokens: Option<u64>,
    max_output_tokens: Option<u64>,
    voice: Option<bool>,
    computer_use: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchProviderAvailability {
    provider: String,
    configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProviderAvailability {
    provider: String,
    configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWebSearchConfig {
    active_provider: String,
    provider_availability: Vec<WebSearchProviderAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReviewModelConfig {
    mode: String,
    provider: Option<String>,
    model: Option<String>,
}
mod env;
mod mcp_config;
mod model_catalog;
mod settings;
mod user_config;

pub(crate) use env::load_global_env;
use env::{has_configured_value, load_workspace_env, resolve_agent_cli_binary};
use mcp_config::{
    get_user_mcp_config_path, get_workspace_mcp_config_path, load_mcp_config_document,
    save_mcp_config_document,
};
use model_catalog::{create_provider_model_http_client, fetch_provider_model_catalog};
pub(crate) use settings::UserDesktopLaunchPreferences;
use settings::{
    clamp_ai_context_message_limit, clamp_archived_session_retention_days,
    clamp_assistant_bubble_hide_seconds, clamp_autopilot_iteration_limit,
    clamp_executor_turn_limit, clamp_inactive_session_archive_days,
    clamp_quick_voice_message_limit, clamp_quick_voice_silence_seconds, create_timestamp_millis,
    normalize_user_agent_limits_settings, normalize_user_agent_limits_settings_input,
    normalize_user_desktop_settings_input, normalize_user_memory_entries,
    normalize_user_review_model_settings, normalize_user_review_model_settings_input,
    resolve_quick_voice_shortcut, UserConfigFile, WorkspaceConfigFile, WorkspaceProfileConfig,
};
pub use settings::{
    McpConfigDocument, UserAgentLimitsSettings, UserDesktopSettings, UserMemorySettings,
    UserReviewModelSettings, UserSpeechToTextSettings, UserVoiceSettings, UserWebSearchSettings,
};
use user_config::{load_user_config_file, write_user_config_file};

pub(crate) fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();

    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
}

fn resolve_runtime_agent_limits(
    user_config: &UserConfigFile,
    workspace_config: &WorkspaceConfigFile,
    profile: Option<&WorkspaceProfileConfig>,
    env: &HashMap<String, String>,
) -> RuntimeAgentLimits {
    let user_settings = normalize_user_agent_limits_settings(&user_config.agent_limits);
    let configured_limits = profile
        .and_then(|entry| entry.agent_limits.as_ref())
        .or(workspace_config.agent_limits.as_ref());
    let mut infinite = user_settings.infinite;
    let mut executor_turns = user_settings.executor_turns;
    let mut autopilot_executor_iterations = user_settings.autopilot_executor_iterations;

    if let Some(configured_limits) = configured_limits {
        if let Some(configured_infinite) = configured_limits.infinite {
            infinite = configured_infinite;
        }

        if let Some(configured_executor_turns) = configured_limits.executor_turns {
            infinite = false;
            executor_turns = clamp_executor_turn_limit(configured_executor_turns);
        }

        if let Some(configured_autopilot_iterations) =
            configured_limits.autopilot_executor_iterations
        {
            infinite = false;
            autopilot_executor_iterations =
                clamp_autopilot_iteration_limit(configured_autopilot_iterations);
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
        executor_turns = clamp_executor_turn_limit(value);
    }

    if let Some(value) = env
        .get("MACHDOCH_AUTOPILOT_ITERATIONS")
        .and_then(|value| value.trim().parse::<u32>().ok())
    {
        infinite = false;
        autopilot_executor_iterations = clamp_autopilot_iteration_limit(value);
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

fn strip_wrapping_quotes(value: &str) -> String {
    let trimmed = value.trim();

    if trimmed.len() >= 2 {
        let starts_with_single = trimmed.starts_with('\'') && trimmed.ends_with('\'');
        let starts_with_double = trimmed.starts_with('"') && trimmed.ends_with('"');

        if starts_with_single || starts_with_double {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }

    trimmed.to_string()
}

pub(crate) fn get_user_config_directory() -> Result<PathBuf, String> {
    if let Some(override_directory) =
        normalize_optional_string(std_env::var("MACHDOCH_USER_CONFIG_DIR").ok().as_deref())
    {
        return Ok(PathBuf::from(override_directory));
    }

    #[cfg(target_os = "windows")]
    {
        let base_directory = std_env::var("APPDATA")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std_env::var("USERPROFILE")
                    .ok()
                    .map(|path| PathBuf::from(path).join("AppData").join("Roaming"))
            })
            .ok_or_else(|| {
                "Unable to determine the Windows roaming config directory.".to_string()
            })?;

        Ok(base_directory.join("machdoch"))
    }

    #[cfg(target_os = "macos")]
    {
        let home_directory = std_env::var("HOME")
            .ok()
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to determine the macOS home directory.".to_string())?;

        return Ok(home_directory
            .join("Library")
            .join("Application Support")
            .join("machdoch"));
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let base_directory = std_env::var("XDG_CONFIG_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std_env::var("HOME")
                    .ok()
                    .map(|path| PathBuf::from(path).join(".config"))
            })
            .ok_or_else(|| "Unable to determine the XDG config directory.".to_string())?;

        Ok(base_directory.join("machdoch"))
    }
}

pub(crate) fn get_default_workspace_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        std_env::var("USERPROFILE")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                let drive = normalize_optional_string(std_env::var("HOMEDRIVE").ok().as_deref())?;
                let path = normalize_optional_string(std_env::var("HOMEPATH").ok().as_deref())?;

                Some(PathBuf::from(format!("{drive}{path}")))
            })
            .or_else(|| std_env::var("HOME").ok().map(PathBuf::from))
            .ok_or_else(|| {
                "Unable to determine the Windows home directory for the default workspace."
                    .to_string()
            })
    }

    #[cfg(not(target_os = "windows"))]
    {
        std_env::var("HOME").ok().map(PathBuf::from).ok_or_else(|| {
            "Unable to determine the home directory for the default workspace.".to_string()
        })
    }
}

pub(crate) fn resolve_workspace_root_path(workspace_root: &str) -> Result<PathBuf, String> {
    let candidate_workspace_path = normalize_optional_string(Some(workspace_root))
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(get_default_workspace_root)?;

    if !candidate_workspace_path.exists() || !candidate_workspace_path.is_dir() {
        return Err(format!(
            "Workspace `{}` does not exist or is not a directory.",
            candidate_workspace_path.display()
        ));
    }

    candidate_workspace_path.canonicalize().map_err(|error| {
        format!(
            "Unable to resolve workspace `{}`: {error}",
            candidate_workspace_path.display()
        )
    })
}

fn is_user_api_provider(value: &str) -> bool {
    USER_API_PROVIDERS.contains(&value)
}

fn is_agent_cli_provider(value: &str) -> bool {
    AGENT_CLI_PROVIDERS.contains(&value)
}

fn is_user_web_search_provider(value: &str) -> bool {
    USER_WEB_SEARCH_PROVIDERS.contains(&value)
}

fn is_user_audio_ai_provider(value: &str) -> bool {
    USER_AUDIO_AI_PROVIDERS.contains(&value)
}

fn is_valid_model_provider(value: &str) -> bool {
    VALID_MODEL_PROVIDERS.contains(&value)
}

fn is_valid_web_search_provider(value: &str) -> bool {
    VALID_WEB_SEARCH_PROVIDERS.contains(&value)
}

fn is_valid_audio_ai_provider(value: &str) -> bool {
    VALID_AUDIO_AI_PROVIDERS.contains(&value)
}

fn load_user_api_keys() -> Result<HashMap<String, String>, String> {
    let (config, _) = load_user_config_file()?;

    Ok(config
        .api_keys
        .into_iter()
        .filter_map(|(provider, value)| {
            let normalized_provider = normalize_optional_string(Some(provider.as_str()))?;
            let normalized_value = normalize_optional_string(Some(value.as_str()))?;

            if is_user_api_provider(&normalized_provider)
                && has_configured_value(Some(normalized_value.as_str()))
            {
                Some((normalized_provider, normalized_value))
            } else {
                None
            }
        })
        .collect())
}

fn load_user_agent_cli_paths() -> Result<HashMap<String, String>, String> {
    let (config, _) = load_user_config_file()?;

    Ok(config
        .agent_cli_paths
        .into_iter()
        .filter_map(|(provider, value)| {
            let normalized_provider = normalize_optional_string(Some(provider.as_str()))?;
            let normalized_value = normalize_optional_string(Some(value.as_str()))?;

            if is_agent_cli_provider(&normalized_provider) {
                Some((normalized_provider, normalized_value))
            } else {
                None
            }
        })
        .collect())
}

fn load_user_web_search_api_keys() -> Result<HashMap<String, String>, String> {
    let (config, _) = load_user_config_file()?;

    Ok(config
        .web_search
        .api_keys
        .into_iter()
        .filter_map(|(provider, value)| {
            let normalized_provider = normalize_optional_string(Some(provider.as_str()))?;
            let normalized_value = normalize_optional_string(Some(value.as_str()))?;

            if is_user_web_search_provider(&normalized_provider)
                && has_configured_value(Some(normalized_value.as_str()))
            {
                Some((normalized_provider, normalized_value))
            } else {
                None
            }
        })
        .collect())
}

fn merge_user_api_keys_into_env(values: &mut HashMap<String, String>) -> Result<(), String> {
    let api_keys = load_user_api_keys()?;

    for (provider, env_key) in PROVIDER_ENV_KEYS {
        if let Some(value) = api_keys.get(provider) {
            values.insert(env_key.to_string(), value.clone());
        }
    }

    Ok(())
}

fn merge_user_agent_cli_paths_into_env(values: &mut HashMap<String, String>) -> Result<(), String> {
    let paths = load_user_agent_cli_paths()?;

    for (provider, env_key) in AGENT_CLI_PROVIDER_ENV_KEYS {
        if let Some(value) = paths.get(provider) {
            values.insert(env_key.to_string(), value.clone());
        }
    }

    Ok(())
}

fn merge_user_web_search_api_keys_into_env(
    values: &mut HashMap<String, String>,
) -> Result<(), String> {
    let api_keys = load_user_web_search_api_keys()?;

    for (provider, env_key) in WEB_SEARCH_ENV_KEYS {
        if let Some(value) = api_keys.get(provider) {
            values.insert(env_key.to_string(), value.clone());
        }
    }

    Ok(())
}

fn load_workspace_config(
    workspace_root: &Path,
) -> Result<(WorkspaceConfigFile, Option<String>), String> {
    let config_path = workspace_root.join(".machdoch").join("config.json");

    if !config_path.exists() {
        return Ok((WorkspaceConfigFile::default(), None));
    }

    let raw = fs::read_to_string(&config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    let parsed = serde_json::from_str::<WorkspaceConfigFile>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;

    Ok((parsed, Some(config_path.display().to_string())))
}

fn load_workspace_config_json(
    config_path: &Path,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !config_path.exists() {
        return Ok(serde_json::Map::new());
    }

    let raw = fs::read_to_string(config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;

    match parsed {
        serde_json::Value::Object(config) => Ok(config),
        _ => Err(format!(
            "Expected workspace config {} to be a JSON object.",
            config_path.display()
        )),
    }
}

fn write_workspace_config_json(
    config_path: &Path,
    config: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
    }

    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(config.clone()))
        .map_err(|error| format!("Failed to serialize workspace config: {error}"))?;

    fs::write(config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))
}

fn save_workspace_default_mode_value(workspace_root: &str, mode: &str) -> Result<PathBuf, String> {
    let normalized_mode = normalize_optional_string(Some(mode))
        .ok_or_else(|| "Expected workspace mode to be one of ask or machdoch.".to_string())?;

    if !is_valid_mode(Some(normalized_mode.as_str())) {
        return Err("Expected workspace mode to be one of ask or machdoch.".to_string());
    }

    let workspace_path = resolve_workspace_root_path(workspace_root)?;
    let config_path = workspace_path.join(".machdoch").join("config.json");
    let mut config = load_workspace_config_json(&config_path)?;

    config.insert(
        "defaultMode".to_string(),
        serde_json::Value::String(normalized_mode),
    );
    write_workspace_config_json(&config_path, &config)?;

    Ok(config_path)
}

fn save_workspace_reasoning_mode_value(
    workspace_root: &str,
    reasoning: &str,
) -> Result<PathBuf, String> {
    let normalized_reasoning = normalize_optional_string(Some(reasoning)).ok_or_else(|| {
        "Expected workspace reasoning to be one of default, none, minimal, low, medium, high, xhigh, or max.".to_string()
    })?;

    if !is_valid_reasoning_mode(Some(normalized_reasoning.as_str())) {
        return Err(
            "Expected workspace reasoning to be one of default, none, minimal, low, medium, high, xhigh, or max."
                .to_string(),
        );
    }

    let workspace_path = resolve_workspace_root_path(workspace_root)?;
    let config_path = workspace_path.join(".machdoch").join("config.json");
    let mut config = load_workspace_config_json(&config_path)?;

    config.insert(
        "reasoning".to_string(),
        serde_json::Value::String(normalized_reasoning),
    );
    write_workspace_config_json(&config_path, &config)?;

    Ok(config_path)
}

fn get_provider_availability(env: &HashMap<String, String>) -> Vec<ProviderAvailability> {
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

fn get_web_search_provider_availability(
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

fn get_audio_provider_availability(
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

fn resolve_audio_active_provider(configured_provider: Option<&str>) -> String {
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

fn resolve_web_search_active_provider(
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

fn is_valid_mode(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .is_some_and(|value| crate::runtime_contract_generated::RUN_MODES.contains(&value))
}

fn is_valid_reasoning_mode(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .is_some_and(|value| REASONING_MODES.contains(&value))
}

fn get_available_profiles(
    profiles: &HashMap<String, WorkspaceProfileConfig>,
) -> Vec<RuntimeProfileSummary> {
    let mut summaries = profiles
        .iter()
        .map(|(name, profile)| RuntimeProfileSummary {
            name: name.clone(),
            description: normalize_optional_string(profile.description.as_deref()),
        })
        .collect::<Vec<_>>();

    summaries.sort_by(|left, right| left.name.cmp(&right.name));
    summaries
}

fn resolve_profile<'a>(
    config: &'a WorkspaceConfigFile,
    env: &HashMap<String, String>,
    override_profile: Option<&str>,
) -> Result<(Option<String>, Option<&'a WorkspaceProfileConfig>), String> {
    let requested_profile = normalize_optional_string(
        override_profile
            .or(env.get("MACHDOCH_PROFILE").map(String::as_str))
            .or(config.default_profile.as_deref()),
    );

    let Some(requested_profile) = requested_profile else {
        return Ok((None, None));
    };

    let Some(profile) = config.profiles.get(&requested_profile) else {
        return Err(format!(
            "Profile `{requested_profile}` was not found in .machdoch/config.json."
        ));
    };

    Ok((Some(requested_profile), Some(profile)))
}

fn resolve_compatibility(
    config: &WorkspaceConfigFile,
    profile: Option<&WorkspaceProfileConfig>,
) -> RuntimeCompatibilityConfig {
    RuntimeCompatibilityConfig {
        discover_github_customizations: profile
            .and_then(|entry| entry.compatibility.as_ref())
            .and_then(|entry| entry.discover_github_customizations)
            .or(config
                .compatibility
                .as_ref()
                .and_then(|entry| entry.discover_github_customizations))
            .unwrap_or(false),
    }
}

fn save_user_api_key(provider: &str, api_key: &str) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider)).ok_or_else(|| {
        "Expected provider to be one of openai, anthropic, or google.".to_string()
    })?;
    let normalized_api_key = normalize_optional_string(Some(api_key))
        .ok_or_else(|| "Expected a non-empty API key.".to_string())?;

    if !is_user_api_provider(&normalized_provider) {
        return Err("Expected provider to be one of openai, anthropic, or google.".to_string());
    }

    let (mut config, config_path) = load_user_config_file()?;

    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
    }

    config
        .api_keys
        .insert(normalized_provider, normalized_api_key);

    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Failed to serialize user config: {error}"))?;

    fs::write(&config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;

    Ok(config_path)
}

fn load_user_web_search_settings() -> Result<UserWebSearchSettings, String> {
    let (config, _) = load_user_config_file()?;
    let env = load_global_env()?;

    Ok(UserWebSearchSettings {
        active_provider: resolve_web_search_active_provider(
            config.web_search.active_provider.as_deref(),
            &env,
        ),
        api_keys: load_user_web_search_api_keys()?,
        provider_availability: get_web_search_provider_availability(&env),
    })
}

fn load_user_voice_settings() -> Result<UserVoiceSettings, String> {
    let (config, _) = load_user_config_file()?;
    let env = load_global_env()?;

    Ok(UserVoiceSettings {
        active_provider: resolve_audio_active_provider(config.voice.active_provider.as_deref()),
        provider_availability: get_audio_provider_availability(&env),
    })
}

fn load_user_speech_to_text_settings() -> Result<UserSpeechToTextSettings, String> {
    let (config, _) = load_user_config_file()?;
    let env = load_global_env()?;

    Ok(UserSpeechToTextSettings {
        active_provider: resolve_audio_active_provider(
            config.speech_to_text.active_provider.as_deref(),
        ),
        input_device_id: normalize_optional_string(
            config.speech_to_text.input_device_id.as_deref(),
        ),
        provider_availability: get_audio_provider_availability(&env),
    })
}

fn load_user_memory_settings() -> Result<UserMemorySettings, String> {
    let (config, _) = load_user_config_file()?;

    Ok(UserMemorySettings {
        global_enabled: config.memory.global_enabled.unwrap_or(false),
        entries: normalize_user_memory_entries(&config.memory.entries, "global"),
    })
}

fn load_user_review_model_settings() -> Result<UserReviewModelSettings, String> {
    let (config, _) = load_user_config_file()?;

    Ok(normalize_user_review_model_settings(&config.review_model))
}

pub(crate) fn load_user_desktop_launch_preferences() -> Result<UserDesktopLaunchPreferences, String>
{
    let (config, _) = load_user_config_file()?;

    Ok(UserDesktopLaunchPreferences {
        autostart_minimized: config
            .desktop
            .autostart_minimized
            .unwrap_or(DEFAULT_DESKTOP_SETTING_AUTOSTART_MINIMIZED),
        autostart_to_tray: config
            .desktop
            .autostart_to_tray
            .unwrap_or(DEFAULT_DESKTOP_SETTING_AUTOSTART_TO_TRAY),
    })
}

pub(crate) fn load_user_desktop_admin_preference() -> Result<bool, String> {
    let (config, _) = load_user_config_file()?;

    Ok(config
        .desktop
        .always_run_as_administrator
        .unwrap_or(DEFAULT_DESKTOP_SETTING_ALWAYS_RUN_AS_ADMINISTRATOR))
}

pub(crate) fn load_user_desktop_settings<R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &M,
) -> Result<UserDesktopSettings, String> {
    let (config, _) = load_user_config_file()?;
    let preferences = load_user_desktop_launch_preferences()?;
    let autostart_enabled = manager
        .autolaunch()
        .is_enabled()
        .map_err(|error| format!("Failed to read the autostart state: {error}"))?;

    Ok(UserDesktopSettings {
        autostart_enabled,
        autostart_minimized: preferences.autostart_minimized,
        autostart_to_tray: preferences.autostart_to_tray,
        always_run_as_administrator: config
            .desktop
            .always_run_as_administrator
            .unwrap_or(DEFAULT_DESKTOP_SETTING_ALWAYS_RUN_AS_ADMINISTRATOR),
        assistant_bubble_enabled: config
            .desktop
            .assistant_bubble_enabled
            .unwrap_or(DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_ENABLED),
        assistant_bubble_hide_when_fullscreen: config
            .desktop
            .assistant_bubble_hide_when_fullscreen
            .unwrap_or(DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_HIDE_WHEN_FULLSCREEN),
        assistant_bubble_temporarily_hide_seconds: clamp_assistant_bubble_hide_seconds(
            config
                .desktop
                .assistant_bubble_temporarily_hide_seconds
                .unwrap_or(DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS),
        ),
        ai_context_max_messages: clamp_ai_context_message_limit(
            config
                .desktop
                .ai_context_max_messages
                .unwrap_or(DEFAULT_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES),
        ),
        inactive_session_archive_days: clamp_inactive_session_archive_days(
            config
                .desktop
                .inactive_session_archive_days
                .unwrap_or(DEFAULT_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS),
        ),
        archived_session_retention_days: clamp_archived_session_retention_days(
            config
                .desktop
                .archived_session_retention_days
                .unwrap_or(DEFAULT_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS),
        ),
        quick_voice_enabled: config
            .desktop
            .quick_voice_enabled
            .unwrap_or(DEFAULT_DESKTOP_SETTING_QUICK_VOICE_ENABLED),
        quick_voice_shortcut: resolve_quick_voice_shortcut(
            config.desktop.quick_voice_shortcut.as_deref(),
        ),
        quick_voice_silence_seconds: clamp_quick_voice_silence_seconds(
            config
                .desktop
                .quick_voice_silence_seconds
                .unwrap_or(DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS),
        ),
        quick_voice_max_messages: clamp_quick_voice_message_limit(
            config
                .desktop
                .quick_voice_max_messages
                .unwrap_or(DEFAULT_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES),
        ),
    })
}

fn save_user_web_search_api_key_value(provider: &str, api_key: &str) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider)).ok_or_else(|| {
        "Expected provider to be one of perplexity, tavily, or serper.".to_string()
    })?;
    let normalized_api_key = normalize_optional_string(Some(api_key))
        .ok_or_else(|| "Expected a non-empty API key.".to_string())?;

    if !is_user_web_search_provider(&normalized_provider) {
        return Err("Expected provider to be one of perplexity, tavily, or serper.".to_string());
    }

    let (mut config, config_path) = load_user_config_file()?;

    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
    }

    config
        .web_search
        .api_keys
        .insert(normalized_provider, normalized_api_key);

    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Failed to serialize user config: {error}"))?;

    fs::write(&config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;

    Ok(config_path)
}

fn save_user_web_search_active_provider_value(provider: &str) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider)).ok_or_else(|| {
        "Expected provider to be one of none, perplexity, tavily, or serper.".to_string()
    })?;

    if !is_valid_web_search_provider(&normalized_provider) {
        return Err(
            "Expected provider to be one of none, perplexity, tavily, or serper.".to_string(),
        );
    }

    let (mut config, config_path) = load_user_config_file()?;

    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
    }

    config.web_search.active_provider = Some(normalized_provider);

    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Failed to serialize user config: {error}"))?;

    fs::write(&config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;

    Ok(config_path)
}

fn save_user_voice_active_provider_value(provider: &str) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider))
        .ok_or_else(|| "Expected provider to be one of none, openai, or google.".to_string())?;

    if !is_user_audio_ai_provider(&normalized_provider) && normalized_provider != "none" {
        return Err("Expected provider to be one of none, openai, or google.".to_string());
    }

    let (mut config, config_path) = load_user_config_file()?;

    config.voice.active_provider = Some(normalized_provider);

    write_user_config_file(&config, &config_path)?;

    Ok(config_path)
}

fn save_user_speech_to_text_active_provider_value(provider: &str) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider))
        .ok_or_else(|| "Expected provider to be one of none, openai, or google.".to_string())?;

    if !is_user_audio_ai_provider(&normalized_provider) && normalized_provider != "none" {
        return Err("Expected provider to be one of none, openai, or google.".to_string());
    }

    let (mut config, config_path) = load_user_config_file()?;

    config.speech_to_text.active_provider = Some(normalized_provider);

    write_user_config_file(&config, &config_path)?;

    Ok(config_path)
}

fn save_user_speech_to_text_input_device_value(
    input_device_id: Option<&str>,
) -> Result<PathBuf, String> {
    let (mut config, config_path) = load_user_config_file()?;

    config.speech_to_text.input_device_id = normalize_optional_string(input_device_id);

    write_user_config_file(&config, &config_path)?;

    Ok(config_path)
}

fn save_user_global_memory_enabled_value(enabled: bool) -> Result<PathBuf, String> {
    let (mut config, config_path) = load_user_config_file()?;

    config.memory.global_enabled = Some(enabled);
    config.memory.entries = normalize_user_memory_entries(&config.memory.entries, "global");

    write_user_config_file(&config, &config_path)?;

    Ok(config_path)
}

fn load_user_agent_limits_settings() -> Result<UserAgentLimitsSettings, String> {
    let (config, _) = load_user_config_file()?;

    Ok(normalize_user_agent_limits_settings(&config.agent_limits))
}

fn save_user_agent_limits_settings_value(
    settings: &UserAgentLimitsSettings,
) -> Result<PathBuf, String> {
    let normalized_settings = normalize_user_agent_limits_settings_input(settings);
    let (mut config, config_path) = load_user_config_file()?;

    config.agent_limits.infinite = Some(normalized_settings.infinite);
    config.agent_limits.executor_turns = Some(normalized_settings.executor_turns);
    config.agent_limits.autopilot_executor_iterations =
        Some(normalized_settings.autopilot_executor_iterations);

    write_user_config_file(&config, &config_path)?;

    Ok(config_path)
}

fn save_user_review_model_settings_value(
    settings: &UserReviewModelSettings,
) -> Result<PathBuf, String> {
    let normalized_settings = normalize_user_review_model_settings_input(settings);
    let (mut config, config_path) = load_user_config_file()?;

    config.review_model.mode = Some(normalized_settings.mode);
    config.review_model.provider = normalized_settings.provider;
    config.review_model.model = normalized_settings.model;

    write_user_config_file(&config, &config_path)?;

    Ok(config_path)
}

fn save_user_desktop_settings_value<R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &M,
    settings: &UserDesktopSettings,
) -> Result<PathBuf, String> {
    let normalized_settings = normalize_user_desktop_settings_input(settings)?;
    let (mut config, config_path) = load_user_config_file()?;

    config.desktop.autostart_minimized = Some(normalized_settings.autostart_minimized);
    config.desktop.autostart_to_tray = Some(normalized_settings.autostart_to_tray);
    config.desktop.always_run_as_administrator =
        Some(normalized_settings.always_run_as_administrator);
    config.desktop.assistant_bubble_enabled = Some(normalized_settings.assistant_bubble_enabled);
    config.desktop.assistant_bubble_hide_when_fullscreen =
        Some(normalized_settings.assistant_bubble_hide_when_fullscreen);
    config.desktop.assistant_bubble_temporarily_hide_seconds =
        Some(normalized_settings.assistant_bubble_temporarily_hide_seconds);
    config.desktop.ai_context_max_messages = Some(normalized_settings.ai_context_max_messages);
    config.desktop.inactive_session_archive_days =
        Some(normalized_settings.inactive_session_archive_days);
    config.desktop.archived_session_retention_days =
        Some(normalized_settings.archived_session_retention_days);
    config.desktop.quick_voice_enabled = Some(normalized_settings.quick_voice_enabled);
    config.desktop.quick_voice_shortcut = Some(normalized_settings.quick_voice_shortcut.clone());
    config.desktop.quick_voice_silence_seconds =
        Some(normalized_settings.quick_voice_silence_seconds);
    config.desktop.quick_voice_max_messages = Some(normalized_settings.quick_voice_max_messages);

    write_user_config_file(&config, &config_path)?;

    let autolaunch = manager.autolaunch();
    let currently_enabled = autolaunch
        .is_enabled()
        .map_err(|error| format!("Failed to read the autostart state: {error}"))?;

    if normalized_settings.autostart_enabled && !currently_enabled {
        autolaunch
            .enable()
            .map_err(|error| format!("Failed to enable autostart: {error}"))?;
    } else if !normalized_settings.autostart_enabled && currently_enabled {
        autolaunch
            .disable()
            .map_err(|error| format!("Failed to disable autostart: {error}"))?;
    }

    Ok(config_path)
}

#[tauri::command]
pub async fn get_global_provider_availability() -> Result<Vec<ProviderAvailability>, String> {
    let env = load_global_env()?;
    Ok(get_provider_availability(&env))
}

#[tauri::command]
pub async fn get_provider_model_catalog() -> Result<ProviderModelCatalogSnapshot, String> {
    let env = load_global_env()?;
    let client = create_provider_model_http_client()?;
    let mut providers = Vec::new();

    for provider in VALID_MODEL_PROVIDERS {
        providers.push(fetch_provider_model_catalog(&client, &env, provider).await);
    }

    Ok(ProviderModelCatalogSnapshot {
        generated_at: create_timestamp_millis(),
        providers,
    })
}

#[tauri::command]
pub async fn get_user_desktop_settings(
    app: tauri::AppHandle,
) -> Result<UserDesktopSettings, String> {
    load_user_desktop_settings(&app)
}

#[tauri::command]
pub async fn get_user_provider_api_keys() -> Result<HashMap<String, String>, String> {
    load_user_api_keys()
}

#[tauri::command]
pub async fn save_user_provider_api_key(
    provider: String,
    api_key: String,
) -> Result<Vec<ProviderAvailability>, String> {
    save_user_api_key(&provider, &api_key)?;

    let env = load_global_env()?;
    Ok(get_provider_availability(&env))
}

#[tauri::command]
pub async fn get_user_web_search_settings() -> Result<UserWebSearchSettings, String> {
    load_user_web_search_settings()
}

#[tauri::command]
pub async fn get_user_voice_settings() -> Result<UserVoiceSettings, String> {
    load_user_voice_settings()
}

#[tauri::command]
pub async fn get_user_speech_to_text_settings() -> Result<UserSpeechToTextSettings, String> {
    load_user_speech_to_text_settings()
}

#[tauri::command]
pub async fn get_user_memory_settings() -> Result<UserMemorySettings, String> {
    load_user_memory_settings()
}

#[tauri::command]
pub async fn get_user_mcp_config_document() -> Result<McpConfigDocument, String> {
    load_mcp_config_document("user", get_user_mcp_config_path()?)
}

#[tauri::command]
pub async fn save_user_mcp_config_document(raw: String) -> Result<McpConfigDocument, String> {
    save_mcp_config_document("user", get_user_mcp_config_path()?, &raw)
}

#[tauri::command]
pub async fn get_workspace_mcp_config_document(
    workspace_root: String,
) -> Result<McpConfigDocument, String> {
    load_mcp_config_document("workspace", get_workspace_mcp_config_path(&workspace_root)?)
}

#[tauri::command]
pub async fn save_workspace_mcp_config_document(
    workspace_root: String,
    raw: String,
) -> Result<McpConfigDocument, String> {
    save_mcp_config_document(
        "workspace",
        get_workspace_mcp_config_path(&workspace_root)?,
        &raw,
    )
}

#[tauri::command]
pub async fn get_user_agent_limits_settings() -> Result<UserAgentLimitsSettings, String> {
    load_user_agent_limits_settings()
}

#[tauri::command]
pub async fn get_user_review_model_settings() -> Result<UserReviewModelSettings, String> {
    load_user_review_model_settings()
}

#[tauri::command]
pub async fn save_user_desktop_settings(
    app: tauri::AppHandle,
    settings: UserDesktopSettings,
) -> Result<UserDesktopSettings, String> {
    let previous_settings = load_user_desktop_settings(&app)?;

    save_user_desktop_settings_value(&app, &settings)?;

    if let Err(error) = crate::desktop_shell::sync_quick_voice_shortcut(&app) {
        let _ = save_user_desktop_settings_value(&app, &previous_settings);
        let _ = crate::desktop_shell::sync_quick_voice_shortcut(&app);

        return Err(format!(
            "The Quick Voice shortcut could not be updated, so the desktop settings were restored: {error}"
        ));
    }

    if let Err(error) = crate::desktop_shell::sync_assistant_bubble_window(&app) {
        eprintln!(
            "Failed to sync the assistant bubble window after saving desktop settings: {error}"
        );
    }

    let next_settings = load_user_desktop_settings(&app)?;

    if next_settings.always_run_as_administrator {
        crate::desktop_shell::restart_as_administrator_if_needed(&app)?;
    }

    Ok(next_settings)
}

#[tauri::command]
pub async fn save_user_web_search_api_key(
    provider: String,
    api_key: String,
) -> Result<UserWebSearchSettings, String> {
    save_user_web_search_api_key_value(&provider, &api_key)?;
    load_user_web_search_settings()
}

#[tauri::command]
pub async fn save_user_web_search_active_provider(
    provider: String,
) -> Result<UserWebSearchSettings, String> {
    save_user_web_search_active_provider_value(&provider)?;
    load_user_web_search_settings()
}

#[tauri::command]
pub async fn save_user_voice_active_provider(
    provider: String,
) -> Result<UserVoiceSettings, String> {
    save_user_voice_active_provider_value(&provider)?;
    load_user_voice_settings()
}

#[tauri::command]
pub async fn save_user_speech_to_text_active_provider(
    provider: String,
) -> Result<UserSpeechToTextSettings, String> {
    save_user_speech_to_text_active_provider_value(&provider)?;
    load_user_speech_to_text_settings()
}

#[tauri::command]
pub async fn save_user_speech_to_text_input_device(
    input_device_id: Option<String>,
) -> Result<UserSpeechToTextSettings, String> {
    save_user_speech_to_text_input_device_value(input_device_id.as_deref())?;
    load_user_speech_to_text_settings()
}

#[tauri::command]
pub async fn save_user_global_memory_enabled(enabled: bool) -> Result<UserMemorySettings, String> {
    save_user_global_memory_enabled_value(enabled)?;
    load_user_memory_settings()
}

#[tauri::command]
pub async fn save_user_agent_limits_settings(
    settings: UserAgentLimitsSettings,
) -> Result<UserAgentLimitsSettings, String> {
    save_user_agent_limits_settings_value(&settings)?;
    load_user_agent_limits_settings()
}

#[tauri::command]
pub async fn save_user_review_model_settings(
    settings: UserReviewModelSettings,
) -> Result<UserReviewModelSettings, String> {
    save_user_review_model_settings_value(&settings)?;
    load_user_review_model_settings()
}

#[tauri::command]
pub async fn save_workspace_default_mode(
    workspace_root: String,
    mode: String,
) -> Result<String, String> {
    let config_path = save_workspace_default_mode_value(&workspace_root, &mode)?;

    Ok(config_path.display().to_string())
}

#[tauri::command]
pub async fn save_workspace_reasoning_mode(
    workspace_root: String,
    reasoning: String,
) -> Result<String, String> {
    let config_path = save_workspace_reasoning_mode_value(&workspace_root, &reasoning)?;

    Ok(config_path.display().to_string())
}

#[tauri::command]
pub async fn get_runtime_snapshot(
    workspace_root: String,
    profile: Option<String>,
) -> Result<RuntimeSnapshot, String> {
    let workspace_path = resolve_workspace_root_path(&workspace_root)?;
    let resolved_workspace_root = workspace_path.display().to_string();

    let env = load_workspace_env(&workspace_path)?;
    let (config, workspace_config_path) = load_workspace_config(&workspace_path)?;
    let (user_config, _) = load_user_config_file()?;
    let (active_profile, profile) = resolve_profile(&config, &env, profile.as_deref())?;
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
    } else if is_valid_mode(profile.and_then(|entry| entry.mode.as_deref())) {
        profile
            .and_then(|entry| entry.mode.as_deref())
            .unwrap_or("machdoch")
            .trim()
            .to_string()
    } else {
        default_mode.clone()
    };

    let provider = resolve_provider(
        profile
            .and_then(|entry| entry.provider.as_deref())
            .or(config.provider.as_deref()),
        &provider_availability,
    );

    let model = normalize_optional_string(
        profile
            .and_then(|entry| entry.model.as_deref())
            .or(config.model.as_deref())
            .or(env.get("MACHDOCH_MODEL").map(String::as_str)),
    )
    .unwrap_or_else(|| default_model_for_provider(&provider).to_string());

    let reasoning = if is_valid_reasoning_mode(env.get("MACHDOCH_REASONING").map(String::as_str)) {
        env.get("MACHDOCH_REASONING")
            .map(String::as_str)
            .unwrap_or("default")
            .trim()
            .to_string()
    } else if is_valid_reasoning_mode(profile.and_then(|entry| entry.reasoning.as_deref())) {
        profile
            .and_then(|entry| entry.reasoning.as_deref())
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
    ) || profile
        .and_then(|entry| entry.offline)
        .or(config.offline)
        .unwrap_or(false);
    let review_model = normalize_user_review_model_settings(&user_config.review_model);

    Ok(RuntimeSnapshot {
        workspace_root: resolved_workspace_root,
        workspace_config_path,
        active_profile,
        available_profiles: get_available_profiles(&config.profiles),
        default_mode,
        default_reasoning,
        mode,
        provider,
        model,
        reasoning,
        offline,
        agent_limits: resolve_runtime_agent_limits(&user_config, &config, profile, &env),
        compatibility: resolve_compatibility(&config, profile),
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
