use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::{
    is_valid_model_provider, normalize_optional_string, AudioProviderAvailability,
    WebSearchProviderAvailability,
};
use crate::runtime_contract_generated::{
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SHORTCUT,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS, DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
    DEFAULT_MAX_EXECUTOR_TURNS, DEFAULT_USER_AGENT_LIMITS_INFINITE, DEFAULT_USER_REVIEW_MODEL_MODE,
    MAX_CONFIGURED_AUTOPILOT_ITERATIONS, MAX_CONFIGURED_EXECUTOR_TURNS,
    MAX_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    MAX_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    MAX_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    MAX_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    MAX_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES, MAX_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
    MIN_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    MIN_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    MIN_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    MIN_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    MIN_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES, MIN_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
    USER_REVIEW_MODEL_MODES,
};

const MAX_GLOBAL_MEMORY_ENTRIES: usize = 40;
const MAX_MEMORY_CONTENT_LENGTH: usize = 280;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserWebSearchSettings {
    pub(super) active_provider: String,
    pub(super) api_keys: HashMap<String, String>,
    pub(super) provider_availability: Vec<WebSearchProviderAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserVoiceSettings {
    pub(super) active_provider: String,
    pub(super) provider_availability: Vec<AudioProviderAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSpeechToTextSettings {
    pub(super) active_provider: String,
    pub(super) input_device_id: Option<String>,
    pub(super) provider_availability: Vec<AudioProviderAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMemorySettings {
    pub(super) global_enabled: bool,
    pub(super) entries: Vec<UserMemoryEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigDocument {
    pub(super) scope: String,
    pub(super) path: String,
    pub(super) exists: bool,
    pub(super) raw: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserReviewModelSettings {
    pub(super) mode: String,
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAgentLimitsSettings {
    pub(super) infinite: bool,
    pub(super) executor_turns: u32,
    pub(super) autopilot_executor_iterations: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDesktopSettings {
    pub(crate) autostart_enabled: bool,
    pub(crate) autostart_minimized: bool,
    pub(crate) autostart_to_tray: bool,
    pub(crate) always_run_as_administrator: bool,
    pub(crate) assistant_bubble_enabled: bool,
    pub(crate) assistant_bubble_hide_when_fullscreen: bool,
    pub(crate) assistant_bubble_temporarily_hide_seconds: u32,
    pub(crate) ai_context_max_messages: u32,
    pub(crate) inactive_session_archive_days: u32,
    pub(crate) archived_session_retention_days: u32,
    pub(crate) quick_voice_enabled: bool,
    pub(crate) quick_voice_shortcut: String,
    pub(crate) quick_voice_silence_seconds: f64,
    pub(crate) quick_voice_max_messages: u32,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct UserDesktopLaunchPreferences {
    pub(crate) autostart_minimized: bool,
    pub(crate) autostart_to_tray: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceConfigFile {
    pub(super) default_profile: Option<String>,
    pub(super) default_mode: Option<String>,
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
    pub(super) reasoning: Option<String>,
    pub(super) offline: Option<bool>,
    pub(super) agent_limits: Option<UserAgentLimitsConfigFile>,
    pub(super) compatibility: Option<WorkspaceCompatibilityConfig>,
    #[serde(default)]
    pub(super) profiles: HashMap<String, WorkspaceProfileConfig>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceProfileConfig {
    pub(super) description: Option<String>,
    pub(super) mode: Option<String>,
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
    pub(super) reasoning: Option<String>,
    pub(super) offline: Option<bool>,
    pub(super) agent_limits: Option<UserAgentLimitsConfigFile>,
    pub(super) compatibility: Option<WorkspaceCompatibilityConfig>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceCompatibilityConfig {
    pub(super) discover_github_customizations: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserConfigFile {
    #[serde(default)]
    pub(super) api_keys: HashMap<String, String>,
    #[serde(default)]
    pub(super) agent_cli_paths: HashMap<String, String>,
    #[serde(default)]
    pub(super) web_search: UserWebSearchConfigFile,
    #[serde(default)]
    pub(super) voice: UserVoiceConfigFile,
    #[serde(default)]
    pub(super) speech_to_text: UserSpeechToTextConfigFile,
    #[serde(default)]
    pub(super) desktop: UserDesktopConfigFile,
    #[serde(default)]
    pub(super) agent_limits: UserAgentLimitsConfigFile,
    #[serde(default)]
    pub(super) memory: UserMemoryConfigFile,
    #[serde(default)]
    pub(super) review_model: UserReviewModelConfigFile,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserWebSearchConfigFile {
    pub(super) active_provider: Option<String>,
    #[serde(default)]
    pub(super) api_keys: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserVoiceConfigFile {
    pub(super) active_provider: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserSpeechToTextConfigFile {
    pub(super) active_provider: Option<String>,
    pub(super) input_device_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserDesktopConfigFile {
    pub(super) autostart_minimized: Option<bool>,
    pub(super) autostart_to_tray: Option<bool>,
    pub(super) always_run_as_administrator: Option<bool>,
    pub(super) assistant_bubble_enabled: Option<bool>,
    pub(super) assistant_bubble_hide_when_fullscreen: Option<bool>,
    pub(super) assistant_bubble_temporarily_hide_seconds: Option<u32>,
    pub(super) ai_context_max_messages: Option<u32>,
    pub(super) inactive_session_archive_days: Option<u32>,
    pub(super) archived_session_retention_days: Option<u32>,
    pub(super) quick_voice_enabled: Option<bool>,
    pub(super) quick_voice_shortcut: Option<String>,
    pub(super) quick_voice_silence_seconds: Option<f64>,
    pub(super) quick_voice_max_messages: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserAgentLimitsConfigFile {
    pub(super) infinite: Option<bool>,
    pub(super) executor_turns: Option<u32>,
    pub(super) autopilot_executor_iterations: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserMemoryConfigFile {
    pub(super) global_enabled: Option<bool>,
    #[serde(default)]
    pub(super) entries: Vec<UserMemoryEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserReviewModelConfigFile {
    pub(super) mode: Option<String>,
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMemoryEntry {
    pub(super) id: String,
    pub(super) scope: String,
    pub(super) content: String,
    pub(super) created_at: u64,
    pub(super) updated_at: u64,
}

pub(super) fn clamp_assistant_bubble_hide_seconds(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
        MAX_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    )
}

pub(super) fn clamp_quick_voice_silence_seconds(value: f64) -> f64 {
    if !value.is_finite() {
        return DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS;
    }

    ((value * 10.0).round() / 10.0).clamp(
        MIN_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
        MAX_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
    )
}

pub(super) fn clamp_quick_voice_message_limit(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
        MAX_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
    )
}

pub(super) fn clamp_ai_context_message_limit(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
        MAX_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    )
}

pub(super) fn clamp_inactive_session_archive_days(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
        MAX_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    )
}

pub(super) fn clamp_archived_session_retention_days(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
        MAX_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    )
}

pub(super) fn clamp_executor_turn_limit(value: u32) -> u32 {
    value.clamp(1, MAX_CONFIGURED_EXECUTOR_TURNS)
}

pub(super) fn clamp_autopilot_iteration_limit(value: u32) -> u32 {
    value.clamp(1, MAX_CONFIGURED_AUTOPILOT_ITERATIONS)
}

pub(super) fn normalize_user_agent_limits_settings(
    settings: &UserAgentLimitsConfigFile,
) -> UserAgentLimitsSettings {
    UserAgentLimitsSettings {
        infinite: settings
            .infinite
            .unwrap_or(DEFAULT_USER_AGENT_LIMITS_INFINITE),
        executor_turns: settings
            .executor_turns
            .map(clamp_executor_turn_limit)
            .unwrap_or(DEFAULT_MAX_EXECUTOR_TURNS),
        autopilot_executor_iterations: settings
            .autopilot_executor_iterations
            .map(clamp_autopilot_iteration_limit)
            .unwrap_or(DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS),
    }
}

pub(super) fn normalize_user_agent_limits_settings_input(
    settings: &UserAgentLimitsSettings,
) -> UserAgentLimitsSettings {
    UserAgentLimitsSettings {
        infinite: settings.infinite,
        executor_turns: clamp_executor_turn_limit(settings.executor_turns),
        autopilot_executor_iterations: clamp_autopilot_iteration_limit(
            settings.autopilot_executor_iterations,
        ),
    }
}

fn is_user_review_model_mode(value: &str) -> bool {
    USER_REVIEW_MODEL_MODES.contains(&value)
}

pub(super) fn normalize_user_review_model_settings(
    settings: &UserReviewModelConfigFile,
) -> UserReviewModelSettings {
    let mode = normalize_optional_string(settings.mode.as_deref())
        .filter(|mode| is_user_review_model_mode(mode))
        .unwrap_or_else(|| DEFAULT_USER_REVIEW_MODEL_MODE.to_string());
    let provider = normalize_optional_string(settings.provider.as_deref());
    let model = normalize_optional_string(settings.model.as_deref());

    if mode != "dedicated" {
        return UserReviewModelSettings {
            mode: "base".to_string(),
            provider: None,
            model: None,
        };
    }

    match (provider, model) {
        (Some(provider), Some(model)) if is_valid_model_provider(&provider) => {
            UserReviewModelSettings {
                mode: "dedicated".to_string(),
                provider: Some(provider),
                model: Some(model),
            }
        }
        _ => UserReviewModelSettings {
            mode: "base".to_string(),
            provider: None,
            model: None,
        },
    }
}

pub(super) fn normalize_user_review_model_settings_input(
    settings: &UserReviewModelSettings,
) -> UserReviewModelSettings {
    normalize_user_review_model_settings(&UserReviewModelConfigFile {
        mode: Some(settings.mode.clone()),
        provider: settings.provider.clone(),
        model: settings.model.clone(),
    })
}

fn normalize_quick_voice_shortcut(value: Option<&str>) -> String {
    normalize_optional_string(value)
        .unwrap_or_else(|| DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SHORTCUT.to_string())
}

pub(super) fn resolve_quick_voice_shortcut(value: Option<&str>) -> String {
    let normalized = normalize_quick_voice_shortcut(value);

    if crate::desktop_shell::validate_quick_voice_shortcut(&normalized).is_ok() {
        normalized
    } else {
        DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SHORTCUT.to_string()
    }
}

pub(super) fn normalize_user_desktop_settings_input(
    settings: &UserDesktopSettings,
) -> Result<UserDesktopSettings, String> {
    let quick_voice_shortcut =
        normalize_quick_voice_shortcut(Some(settings.quick_voice_shortcut.as_str()));

    crate::desktop_shell::validate_quick_voice_shortcut(&quick_voice_shortcut)?;

    Ok(UserDesktopSettings {
        autostart_enabled: settings.autostart_enabled,
        autostart_minimized: settings.autostart_minimized,
        autostart_to_tray: settings.autostart_to_tray,
        always_run_as_administrator: settings.always_run_as_administrator,
        assistant_bubble_enabled: settings.assistant_bubble_enabled,
        assistant_bubble_hide_when_fullscreen: settings.assistant_bubble_hide_when_fullscreen,
        assistant_bubble_temporarily_hide_seconds: clamp_assistant_bubble_hide_seconds(
            settings.assistant_bubble_temporarily_hide_seconds,
        ),
        ai_context_max_messages: clamp_ai_context_message_limit(settings.ai_context_max_messages),
        inactive_session_archive_days: clamp_inactive_session_archive_days(
            settings.inactive_session_archive_days,
        ),
        archived_session_retention_days: clamp_archived_session_retention_days(
            settings.archived_session_retention_days,
        ),
        quick_voice_enabled: settings.quick_voice_enabled,
        quick_voice_shortcut,
        quick_voice_silence_seconds: clamp_quick_voice_silence_seconds(
            settings.quick_voice_silence_seconds,
        ),
        quick_voice_max_messages: clamp_quick_voice_message_limit(
            settings.quick_voice_max_messages,
        ),
    })
}

pub(super) fn create_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_memory_content(value: &str) -> Option<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();

    if trimmed.is_empty() {
        return None;
    }

    if trimmed.len() <= MAX_MEMORY_CONTENT_LENGTH {
        return Some(trimmed.to_string());
    }

    let end = MAX_MEMORY_CONTENT_LENGTH.saturating_sub(1);
    let prefix = trimmed.chars().take(end).collect::<String>();
    Some(format!("{}…", prefix))
}

pub(super) fn normalize_user_memory_entries(
    entries: &[UserMemoryEntry],
    scope: &str,
) -> Vec<UserMemoryEntry> {
    let mut merged = HashMap::<String, UserMemoryEntry>::new();

    for (index, entry) in entries.iter().enumerate() {
        let Some(content) = normalize_memory_content(&entry.content) else {
            continue;
        };

        let created_at = if entry.created_at == 0 {
            create_timestamp_millis()
        } else {
            entry.created_at
        };
        let updated_at = if entry.updated_at == 0 {
            created_at
        } else {
            entry.updated_at
        };
        let normalized_entry = UserMemoryEntry {
            id: normalize_optional_string(Some(entry.id.as_str()))
                .unwrap_or_else(|| format!("global-memory-{}-{}", updated_at, index)),
            scope: scope.to_string(),
            content: content.clone(),
            created_at,
            updated_at,
        };
        let key = content.to_lowercase();

        match merged.get(&key) {
            Some(existing) if existing.updated_at >= normalized_entry.updated_at => {}
            _ => {
                merged.insert(key, normalized_entry);
            }
        }
    }

    let mut normalized = merged.into_values().collect::<Vec<_>>();
    normalized.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    normalized.truncate(MAX_GLOBAL_MEMORY_ENTRIES);
    normalized
}
