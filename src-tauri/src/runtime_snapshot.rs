use std::collections::HashMap;

use crate::runtime_contract_generated::{REASONING_MODES, VALID_MODEL_PROVIDERS};
mod collect;
mod desktop_settings_commands;
mod env;
mod env_commands;
mod env_dotenv;
mod env_paths;
mod mcp_config;
mod model_catalog;
mod settings;
mod settings_commands;
mod settings_types;
mod types;
mod user_config;
mod workspace;

use collect::{
    collect_runtime_snapshot, get_audio_provider_availability, get_provider_availability,
    get_web_search_provider_availability, resolve_audio_active_provider,
    resolve_web_search_active_provider,
};
use desktop_settings_commands::save_user_desktop_settings_value;
pub(crate) use desktop_settings_commands::{
    load_user_desktop_admin_preference, load_user_desktop_launch_preferences,
    load_user_desktop_settings,
};
pub(crate) use env::load_global_env;
use mcp_config::{
    get_user_mcp_config_path, get_workspace_mcp_config_path, load_mcp_config_document,
    save_mcp_config_document,
};
use model_catalog::{create_provider_model_http_client, fetch_provider_model_catalog};
use settings::create_timestamp_millis;
use settings_commands::{
    load_user_agent_limits_settings, load_user_api_keys, load_user_memory_settings,
    load_user_review_model_settings, load_user_speech_to_text_settings, load_user_voice_settings,
    load_user_web_search_settings, save_user_agent_limits_settings_value, save_user_api_key,
    save_user_global_memory_enabled_value, save_user_review_model_settings_value,
    save_user_speech_to_text_active_provider_value, save_user_speech_to_text_input_device_value,
    save_user_voice_active_provider_value, save_user_web_search_active_provider_value,
    save_user_web_search_api_key_value,
};
pub(super) use settings_commands::{
    merge_user_agent_cli_paths_into_env, merge_user_api_keys_into_env,
    merge_user_web_search_api_keys_into_env,
};
pub(crate) use settings_types::UserDesktopLaunchPreferences;
pub use settings_types::{
    McpConfigDocument, UserAgentLimitsSettings, UserDesktopSettings, UserMemorySettings,
    UserReviewModelSettings, UserSpeechToTextSettings, UserVoiceSettings, UserWebSearchSettings,
};
pub use types::{
    AudioProviderAvailability, ProviderAvailability, ProviderModelCatalogProvider,
    ProviderModelCatalogSnapshot, ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
    RuntimeAgentLimits, RuntimeCompatibilityConfig, RuntimeReviewModelConfig, RuntimeSnapshot,
    RuntimeWebSearchConfig, WebSearchProviderAvailability,
};
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

fn is_valid_model_provider(value: &str) -> bool {
    VALID_MODEL_PROVIDERS.contains(&value)
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
