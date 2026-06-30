use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{AudioProviderAvailability, WebSearchProviderAvailability};

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
    pub(super) default_mode: Option<String>,
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
