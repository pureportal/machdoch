use futures_util::{stream, StreamExt};
use std::{collections::HashMap, sync::OnceLock};

use crate::runtime_contract_generated::{REASONING_MODES, VALID_MODEL_PROVIDERS};
mod collect;
mod desktop_settings_commands;
mod env;
mod env_commands;
mod env_paths;
mod env_process;
mod mcp_config;
mod model_catalog;
mod model_catalog_cache;
mod settings;
mod settings_commands;
mod settings_types;
mod types;
pub(crate) mod user_config;
mod workspace;
mod workspace_memory;

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
pub use mcp_config::McpConfigWriteLock;
use mcp_config::{
    get_user_mcp_config_path, get_workspace_mcp_config_path, load_mcp_config_document,
};
use model_catalog::{create_provider_model_http_client, fetch_provider_model_catalog};
use settings::create_timestamp_millis;
pub(crate) use settings_commands::load_user_workspace_run_settings;
use settings_commands::{
    delete_user_api_key, delete_user_web_search_api_key_value, forget_user_global_memory_value,
    load_user_agent_limits_settings, load_user_api_keys, load_user_internal_task_model_settings,
    load_user_memory_settings, load_user_review_model_settings, load_user_speech_to_text_settings,
    load_user_voice_settings, load_user_web_search_settings, save_user_agent_limits_settings_value,
    save_user_api_key, save_user_global_memory_enabled_value,
    save_user_internal_task_model_settings_value, save_user_review_model_settings_value,
    save_user_speech_to_text_active_provider_value, save_user_speech_to_text_input_device_value,
    save_user_voice_active_provider_value, save_user_web_search_active_provider_value,
    save_user_web_search_api_key_value, save_user_workspace_memory_default_enabled_value,
    save_user_workspace_run_settings_value,
};
pub(super) use settings_commands::{
    merge_user_agent_cli_paths_into_env, merge_user_api_keys_into_env,
    merge_user_web_search_api_keys_into_env,
};
pub(crate) use settings_types::UserDesktopLaunchPreferences;
pub use settings_types::{ContextWindow, ReasoningExecutionMode};
pub use settings_types::{
    McpConfigDocument, UserAgentLimitsSettings, UserDesktopSettings, UserInternalTaskModelSettings,
    UserMemoryEntry, UserMemorySettings, UserReviewModelSettings, UserSpeechToTextSettings,
    UserVoiceSettings, UserWebSearchSettings, UserWorkspaceRunSettings,
};
pub use types::{
    AudioProviderAvailability, ProviderAvailability, ProviderModelCatalogProvider,
    ProviderModelCatalogSnapshot, ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
    RuntimeAgentLimits, RuntimeCompatibilityConfig, RuntimeReviewModelConfig, RuntimeSnapshot,
    RuntimeWebSearchConfig, WebSearchProviderAvailability,
};
pub(crate) use workspace::{get_user_config_directory, resolve_workspace_root_path};
use workspace::{
    save_workspace_context_window_value, save_workspace_default_mode_value,
    save_workspace_memory_override_value, save_workspace_reasoning_execution_mode_value,
    save_workspace_reasoning_mode_value,
};
use workspace_memory::{forget_workspace_memory_entry, load_workspace_memory_entries};

static PROVIDER_MODEL_CATALOG_CACHE: OnceLock<model_catalog_cache::ModelCatalogCache> =
    OnceLock::new();

fn provider_model_catalog_cache() -> &'static model_catalog_cache::ModelCatalogCache {
    PROVIDER_MODEL_CATALOG_CACHE.get_or_init(Default::default)
}

async fn invalidate_provider_model_catalog_cache() {
    provider_model_catalog_cache().invalidate().await;
}

pub(crate) fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();

    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
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
    // Keep the refresh alive if its caller goes away: blocking CLI probes must
    // finish and clean up before another caller starts a replacement refresh.
    tokio::spawn(async {
        provider_model_catalog_cache()
            .get_or_refresh(|| async {
                let env = tokio::task::spawn_blocking(load_global_env)
                    .await
                    .map_err(|error| {
                        format!("Model catalog environment reader failed: {error}")
                    })??;
                let client = create_provider_model_http_client()?;
                let probes: Vec<_> = VALID_MODEL_PROVIDERS
                    .iter()
                    .map(|provider| fetch_provider_model_catalog(&client, &env, provider))
                    .collect();
                let providers = stream::iter(probes).buffered(3).collect().await;
                Ok(ProviderModelCatalogSnapshot {
                    generated_at: create_timestamp_millis(),
                    providers,
                })
            })
            .await
    })
    .await
    .map_err(|error| format!("Model catalog refresh failed: {error}"))?
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
    invalidate_provider_model_catalog_cache().await;

    let env = load_global_env()?;
    Ok(get_provider_availability(&env))
}

#[tauri::command]
pub async fn delete_user_provider_api_key(
    provider: String,
) -> Result<Vec<ProviderAvailability>, String> {
    delete_user_api_key(&provider)?;
    invalidate_provider_model_catalog_cache().await;

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
pub async fn get_workspace_memory_entries(
    workspace_root: String,
) -> Result<Vec<UserMemoryEntry>, String> {
    load_workspace_memory_entries(&workspace_root)
}

#[tauri::command]
pub async fn get_user_mcp_config_document() -> Result<McpConfigDocument, String> {
    load_mcp_config_document("user", get_user_mcp_config_path()?)
}

#[tauri::command]
pub async fn save_user_mcp_config_document(
    state: tauri::State<'_, McpConfigWriteLock>,
    raw: String,
    expected_raw: Option<String>,
) -> Result<McpConfigDocument, mcp_config::McpConfigSaveError> {
    let _guard = state.0.lock().map_err(|_| {
        mcp_config::McpConfigSaveError::runtime("The MCP configuration write lock is unavailable.")
    })?;

    mcp_config::save_mcp_config_document_if_unchanged(
        "user",
        get_user_mcp_config_path().map_err(mcp_config::McpConfigSaveError::runtime)?,
        &raw,
        expected_raw.as_deref(),
    )
}

#[tauri::command]
pub async fn get_workspace_mcp_config_document(
    workspace_root: String,
) -> Result<McpConfigDocument, String> {
    load_mcp_config_document("workspace", get_workspace_mcp_config_path(&workspace_root)?)
}

#[tauri::command]
pub async fn save_workspace_mcp_config_document(
    state: tauri::State<'_, McpConfigWriteLock>,
    workspace_root: String,
    raw: String,
    expected_raw: Option<String>,
) -> Result<McpConfigDocument, mcp_config::McpConfigSaveError> {
    let _guard = state.0.lock().map_err(|_| {
        mcp_config::McpConfigSaveError::runtime("The MCP configuration write lock is unavailable.")
    })?;

    mcp_config::save_mcp_config_document_if_unchanged(
        "workspace",
        get_workspace_mcp_config_path(&workspace_root)
            .map_err(mcp_config::McpConfigSaveError::runtime)?,
        &raw,
        expected_raw.as_deref(),
    )
}

#[tauri::command]
pub async fn get_user_agent_limits_settings() -> Result<UserAgentLimitsSettings, String> {
    load_user_agent_limits_settings()
}

#[tauri::command]
pub async fn get_user_workspace_run_settings() -> Result<UserWorkspaceRunSettings, String> {
    load_user_workspace_run_settings()
}

#[tauri::command]
pub async fn get_user_review_model_settings() -> Result<UserReviewModelSettings, String> {
    load_user_review_model_settings()
}

#[tauri::command]
pub async fn get_user_internal_task_model_settings() -> Result<UserInternalTaskModelSettings, String>
{
    load_user_internal_task_model_settings()
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
pub async fn delete_user_web_search_api_key(
    provider: String,
) -> Result<UserWebSearchSettings, String> {
    delete_user_web_search_api_key_value(&provider)?;
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
pub async fn save_user_workspace_memory_default_enabled(
    enabled: bool,
) -> Result<UserMemorySettings, String> {
    save_user_workspace_memory_default_enabled_value(enabled)?;
    load_user_memory_settings()
}

#[tauri::command]
pub async fn forget_user_global_memory_entry(id: String) -> Result<UserMemorySettings, String> {
    forget_user_global_memory_value(&id)?;
    load_user_memory_settings()
}

#[tauri::command]
pub async fn forget_workspace_memory(
    workspace_root: String,
    id: String,
) -> Result<Vec<UserMemoryEntry>, String> {
    forget_workspace_memory_entry(&workspace_root, &id)
}

#[tauri::command]
pub async fn save_user_agent_limits_settings(
    settings: UserAgentLimitsSettings,
) -> Result<UserAgentLimitsSettings, String> {
    save_user_agent_limits_settings_value(&settings)?;
    load_user_agent_limits_settings()
}

#[tauri::command]
pub async fn save_user_workspace_run_settings(
    settings: UserWorkspaceRunSettings,
) -> Result<UserWorkspaceRunSettings, String> {
    save_user_workspace_run_settings_value(&settings)?;
    load_user_workspace_run_settings()
}

#[tauri::command]
pub async fn save_user_review_model_settings(
    settings: UserReviewModelSettings,
) -> Result<UserReviewModelSettings, String> {
    save_user_review_model_settings_value(&settings)?;
    load_user_review_model_settings()
}

#[tauri::command]
pub async fn save_user_internal_task_model_settings(
    settings: UserInternalTaskModelSettings,
) -> Result<UserInternalTaskModelSettings, String> {
    save_user_internal_task_model_settings_value(&settings)?;
    load_user_internal_task_model_settings()
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
pub async fn save_workspace_memory_override(
    workspace_root: String,
    enabled: Option<bool>,
) -> Result<String, String> {
    let config_path = save_workspace_memory_override_value(&workspace_root, enabled)?;

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
pub async fn save_workspace_context_window(
    workspace_root: String,
    context_window: ContextWindow,
) -> Result<String, String> {
    let config_path = save_workspace_context_window_value(&workspace_root, &context_window)?;

    Ok(config_path.display().to_string())
}

#[tauri::command]
pub async fn save_workspace_reasoning_execution_mode(
    workspace_root: String,
    reasoning_mode: ReasoningExecutionMode,
) -> Result<String, String> {
    let config_path =
        save_workspace_reasoning_execution_mode_value(&workspace_root, &reasoning_mode)?;

    Ok(config_path.display().to_string())
}

#[tauri::command]
pub async fn get_runtime_snapshot(workspace_root: String) -> Result<RuntimeSnapshot, String> {
    collect_runtime_snapshot(&workspace_root)
}
