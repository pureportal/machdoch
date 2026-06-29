use std::{collections::HashMap, fs, path::PathBuf};

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
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS, PROVIDER_ENV_KEYS, REASONING_MODES,
    USER_API_PROVIDERS, USER_AUDIO_AI_PROVIDERS, USER_WEB_SEARCH_PROVIDERS, VALID_MODEL_PROVIDERS,
    VALID_WEB_SEARCH_PROVIDERS, WEB_SEARCH_ENV_KEYS,
};
use crate::ui_control::UiControlAvailability;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    workspace_root: String,
    workspace_config_path: Option<String>,
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
mod collect;
mod env;
mod mcp_config;
mod model_catalog;
mod settings;
mod user_config;
mod workspace;

use collect::{
    collect_runtime_snapshot, get_audio_provider_availability, get_provider_availability,
    get_web_search_provider_availability, resolve_audio_active_provider,
    resolve_web_search_active_provider,
};
use env::has_configured_value;
pub(crate) use env::load_global_env;
use mcp_config::{
    get_user_mcp_config_path, get_workspace_mcp_config_path, load_mcp_config_document,
    save_mcp_config_document,
};
use model_catalog::{create_provider_model_http_client, fetch_provider_model_catalog};
pub(crate) use settings::UserDesktopLaunchPreferences;
use settings::{
    clamp_ai_context_message_limit, clamp_archived_session_retention_days,
    clamp_assistant_bubble_hide_seconds, clamp_inactive_session_archive_days,
    clamp_quick_voice_message_limit, clamp_quick_voice_silence_seconds, create_timestamp_millis,
    normalize_user_agent_limits_settings, normalize_user_agent_limits_settings_input,
    normalize_user_desktop_settings_input, normalize_user_memory_entries,
    normalize_user_review_model_settings, normalize_user_review_model_settings_input,
    resolve_quick_voice_shortcut,
};
pub use settings::{
    McpConfigDocument, UserAgentLimitsSettings, UserDesktopSettings, UserMemorySettings,
    UserReviewModelSettings, UserSpeechToTextSettings, UserVoiceSettings, UserWebSearchSettings,
};
use user_config::{load_user_config_file, write_user_config_file};
pub(crate) use workspace::{get_user_config_directory, resolve_workspace_root_path};
use workspace::{save_workspace_default_mode_value, save_workspace_reasoning_mode_value};

pub(crate) fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();

    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
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
pub async fn get_runtime_snapshot(workspace_root: String) -> Result<RuntimeSnapshot, String> {
    collect_runtime_snapshot(&workspace_root)
}
