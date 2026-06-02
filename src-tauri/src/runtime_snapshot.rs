use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri_plugin_autostart::ManagerExt as _;

use crate::runtime_contract_generated::{
    DEFAULT_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    DEFAULT_DESKTOP_SETTING_ALWAYS_RUN_AS_ADMINISTRATOR,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_ENABLED,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_HIDE_WHEN_FULLSCREEN,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    DEFAULT_DESKTOP_SETTING_AUTOSTART_MINIMIZED, DEFAULT_DESKTOP_SETTING_AUTOSTART_TO_TRAY,
    DEFAULT_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    DEFAULT_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_ENABLED, DEFAULT_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SHORTCUT,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS, DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
    DEFAULT_MAX_EXECUTOR_TURNS, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_MODEL_PROVIDER,
    DEFAULT_USER_AGENT_LIMITS_INFINITE, MAX_CONFIGURED_AUTOPILOT_ITERATIONS,
    MAX_CONFIGURED_EXECUTOR_TURNS, MAX_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    MAX_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    MAX_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    MAX_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    MAX_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES, MAX_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
    MIN_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    MIN_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    MIN_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    MIN_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    MIN_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES, MIN_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
    PROVIDER_ENV_KEYS, RUNTIME_ENV_KEYS, USER_API_PROVIDERS, USER_AUDIO_AI_PROVIDERS,
    USER_WEB_SEARCH_PROVIDERS, VALID_AUDIO_AI_PROVIDERS, VALID_MODEL_PROVIDERS,
    VALID_WEB_SEARCH_PROVIDERS, WEB_SEARCH_ENV_KEYS,
};
use crate::ui_control::UiControlAvailability;

const PLACEHOLDER_TOKENS: [&str; 3] = ["YOUR_", "CHANGE_ME", "PLACEHOLDER"];
const KNOWN_SAMPLE_SECRET_VALUES: [&str; 6] = [
    "sk-user-config",
    "sk-live",
    "pplx-live",
    "tvly-live",
    "tavily-live",
    "serper-live",
];
const USER_CONFIG_FILE_NAME: &str = "user-config.json";
const MAX_GLOBAL_MEMORY_ENTRIES: usize = 40;
const MAX_MEMORY_CONTENT_LENGTH: usize = 280;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    workspace_root: String,
    workspace_config_path: Option<String>,
    active_profile: Option<String>,
    available_profiles: Vec<RuntimeProfileSummary>,
    mode: String,
    provider: String,
    model: String,
    offline: bool,
    agent_limits: RuntimeAgentLimits,
    compatibility: RuntimeCompatibilityConfig,
    provider_availability: Vec<ProviderAvailability>,
    web_search: RuntimeWebSearchConfig,
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
    description: Option<String>,
    best_for: Option<String>,
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
pub struct UserWebSearchSettings {
    active_provider: String,
    api_keys: HashMap<String, String>,
    provider_availability: Vec<WebSearchProviderAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserVoiceSettings {
    active_provider: String,
    provider_availability: Vec<AudioProviderAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSpeechToTextSettings {
    active_provider: String,
    input_device_id: Option<String>,
    provider_availability: Vec<AudioProviderAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMemorySettings {
    global_enabled: bool,
    entries: Vec<UserMemoryEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAgentLimitsSettings {
    infinite: bool,
    executor_turns: u32,
    autopilot_executor_iterations: u32,
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
struct WorkspaceConfigFile {
    default_profile: Option<String>,
    default_mode: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    offline: Option<bool>,
    agent_limits: Option<UserAgentLimitsConfigFile>,
    compatibility: Option<WorkspaceCompatibilityConfig>,
    #[serde(default)]
    profiles: HashMap<String, WorkspaceProfileConfig>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceProfileConfig {
    description: Option<String>,
    mode: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    offline: Option<bool>,
    agent_limits: Option<UserAgentLimitsConfigFile>,
    compatibility: Option<WorkspaceCompatibilityConfig>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCompatibilityConfig {
    discover_github_customizations: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserConfigFile {
    #[serde(default)]
    api_keys: HashMap<String, String>,
    #[serde(default)]
    web_search: UserWebSearchConfigFile,
    #[serde(default)]
    voice: UserVoiceConfigFile,
    #[serde(default)]
    speech_to_text: UserSpeechToTextConfigFile,
    #[serde(default)]
    desktop: UserDesktopConfigFile,
    #[serde(default)]
    agent_limits: UserAgentLimitsConfigFile,
    #[serde(default)]
    memory: UserMemoryConfigFile,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserWebSearchConfigFile {
    active_provider: Option<String>,
    #[serde(default)]
    api_keys: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserVoiceConfigFile {
    active_provider: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserSpeechToTextConfigFile {
    active_provider: Option<String>,
    input_device_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserDesktopConfigFile {
    autostart_minimized: Option<bool>,
    autostart_to_tray: Option<bool>,
    always_run_as_administrator: Option<bool>,
    assistant_bubble_enabled: Option<bool>,
    assistant_bubble_hide_when_fullscreen: Option<bool>,
    assistant_bubble_temporarily_hide_seconds: Option<u32>,
    ai_context_max_messages: Option<u32>,
    inactive_session_archive_days: Option<u32>,
    archived_session_retention_days: Option<u32>,
    quick_voice_enabled: Option<bool>,
    quick_voice_shortcut: Option<String>,
    quick_voice_silence_seconds: Option<f64>,
    quick_voice_max_messages: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserAgentLimitsConfigFile {
    infinite: Option<bool>,
    executor_turns: Option<u32>,
    autopilot_executor_iterations: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserMemoryConfigFile {
    global_enabled: Option<bool>,
    #[serde(default)]
    entries: Vec<UserMemoryEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMemoryEntry {
    id: String,
    scope: String,
    content: String,
    created_at: u64,
    updated_at: u64,
}

pub(crate) fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();

    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
}

fn clamp_assistant_bubble_hide_seconds(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
        MAX_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    )
}

fn clamp_quick_voice_silence_seconds(value: f64) -> f64 {
    if !value.is_finite() {
        return DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS;
    }

    ((value * 10.0).round() / 10.0).clamp(
        MIN_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
        MAX_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
    )
}

fn clamp_quick_voice_message_limit(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
        MAX_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
    )
}

fn clamp_ai_context_message_limit(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
        MAX_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    )
}

fn clamp_inactive_session_archive_days(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
        MAX_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    )
}

fn clamp_archived_session_retention_days(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
        MAX_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    )
}

fn clamp_executor_turn_limit(value: u32) -> u32 {
    value.clamp(1, MAX_CONFIGURED_EXECUTOR_TURNS)
}

fn clamp_autopilot_iteration_limit(value: u32) -> u32 {
    value.clamp(1, MAX_CONFIGURED_AUTOPILOT_ITERATIONS)
}

fn normalize_user_agent_limits_settings(
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

fn normalize_user_agent_limits_settings_input(
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

fn normalize_quick_voice_shortcut(value: Option<&str>) -> String {
    normalize_optional_string(value)
        .unwrap_or_else(|| DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SHORTCUT.to_string())
}

fn resolve_quick_voice_shortcut(value: Option<&str>) -> String {
    let normalized = normalize_quick_voice_shortcut(value);

    if crate::desktop_shell::validate_quick_voice_shortcut(&normalized).is_ok() {
        normalized
    } else {
        DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SHORTCUT.to_string()
    }
}

fn normalize_user_desktop_settings_input(
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

fn create_timestamp_millis() -> u64 {
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

fn normalize_user_memory_entries(entries: &[UserMemoryEntry], scope: &str) -> Vec<UserMemoryEntry> {
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

fn parse_dotenv_file(path: &Path) -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some(separator_index) = trimmed.find('=') else {
            continue;
        };

        let key = trimmed[..separator_index].trim();
        let value = strip_wrapping_quotes(&trimmed[separator_index + 1..]);

        values.insert(key.to_string(), value);
    }

    Ok(values)
}

fn apply_process_env_overrides(values: &mut HashMap<String, String>) {
    for key in PROVIDER_ENV_KEYS
        .iter()
        .map(|(_, key)| *key)
        .chain(WEB_SEARCH_ENV_KEYS.iter().map(|(_, key)| *key))
        .chain(RUNTIME_ENV_KEYS.iter().copied())
    {
        if let Ok(value) = env::var(key) {
            values.insert(key.to_string(), value);
        }
    }
}

fn get_user_config_directory() -> Result<PathBuf, String> {
    if let Some(override_directory) =
        normalize_optional_string(env::var("MACHDOCH_USER_CONFIG_DIR").ok().as_deref())
    {
        return Ok(PathBuf::from(override_directory));
    }

    #[cfg(target_os = "windows")]
    {
        let base_directory = env::var("APPDATA")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                env::var("USERPROFILE")
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
        let home_directory = env::var("HOME")
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
        let base_directory = env::var("XDG_CONFIG_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                env::var("HOME")
                    .ok()
                    .map(|path| PathBuf::from(path).join(".config"))
            })
            .ok_or_else(|| "Unable to determine the XDG config directory.".to_string())?;

        Ok(base_directory.join("machdoch"))
    }
}

fn get_user_config_path() -> Result<PathBuf, String> {
    Ok(get_user_config_directory()?.join(USER_CONFIG_FILE_NAME))
}

pub(crate) fn get_default_workspace_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        env::var("USERPROFILE")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                let drive = normalize_optional_string(env::var("HOMEDRIVE").ok().as_deref())?;
                let path = normalize_optional_string(env::var("HOMEPATH").ok().as_deref())?;

                Some(PathBuf::from(format!("{drive}{path}")))
            })
            .or_else(|| env::var("HOME").ok().map(PathBuf::from))
            .ok_or_else(|| {
                "Unable to determine the Windows home directory for the default workspace."
                    .to_string()
            })
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var("HOME").ok().map(PathBuf::from).ok_or_else(|| {
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

fn load_user_config_file() -> Result<(UserConfigFile, PathBuf), String> {
    let config_path = get_user_config_path()?;

    if !config_path.exists() {
        return Ok((UserConfigFile::default(), config_path));
    }

    let raw = fs::read_to_string(&config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    let parsed = serde_json::from_str::<UserConfigFile>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;

    Ok((parsed, config_path))
}

fn write_user_config_file(config: &UserConfigFile, config_path: &Path) -> Result<(), String> {
    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
    }

    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize user config: {error}"))?;

    fs::write(config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))
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

pub(crate) fn load_global_env() -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    merge_user_api_keys_into_env(&mut values)?;
    merge_user_web_search_api_keys_into_env(&mut values)?;
    apply_process_env_overrides(&mut values);
    Ok(values)
}

fn load_workspace_env(workspace_root: &Path) -> Result<HashMap<String, String>, String> {
    let env_path = workspace_root.join(".env");
    let mut values = HashMap::new();

    merge_user_api_keys_into_env(&mut values)?;
    merge_user_web_search_api_keys_into_env(&mut values)?;

    if env_path.exists() {
        for (key, value) in parse_dotenv_file(&env_path)? {
            values.insert(key, value);
        }
    }

    apply_process_env_overrides(&mut values);

    Ok(values)
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

fn has_configured_value(value: Option<&str>) -> bool {
    let Some(value) = value.map(str::trim) else {
        return false;
    };

    if value.is_empty() {
        return false;
    }

    if KNOWN_SAMPLE_SECRET_VALUES.contains(&value) {
        return false;
    }

    !PLACEHOLDER_TOKENS.iter().any(|token| value.contains(token))
}

fn get_provider_availability(env: &HashMap<String, String>) -> Vec<ProviderAvailability> {
    PROVIDER_ENV_KEYS
        .iter()
        .map(|(provider, env_key)| ProviderAvailability {
            provider: provider.to_string(),
            configured: has_configured_value(env.get(*env_key).map(String::as_str)),
        })
        .collect()
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

fn create_provider_model_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("Failed to create provider model HTTP client: {error}"))
}

fn sanitize_provider_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "Provider model discovery timed out.".to_string();
    }

    if let Some(status) = error.status() {
        return format!("Provider model discovery returned HTTP {status}.");
    }

    "Provider model discovery failed before a response was received.".to_string()
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

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .and_then(|entry| normalize_optional_string(Some(entry)))
}

fn json_u64(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key).and_then(serde_json::Value::as_u64)
}

fn json_bool_from_keys(value: Option<&serde_json::Value>, keys: &[&str]) -> Option<bool> {
    let object = value?.as_object()?;

    for key in keys {
        if let Some(value) = object.get(*key).and_then(serde_json::Value::as_bool) {
            return Some(value);
        }
    }

    None
}

fn looks_like_dated_snapshot(model_id: &str) -> bool {
    if model_id.len() >= 10 {
        let tail = &model_id[model_id.len() - 10..];
        let bytes = tail.as_bytes();
        let is_hyphenated_date = bytes.get(4) == Some(&b'-')
            && bytes.get(7) == Some(&b'-')
            && tail
                .chars()
                .enumerate()
                .all(|(index, character)| index == 4 || index == 7 || character.is_ascii_digit());

        if is_hyphenated_date {
            return true;
        }
    }

    let Some(tail) = model_id.rsplit('-').next() else {
        return false;
    };

    tail.len() == 8 && tail.chars().all(|character| character.is_ascii_digit())
}

fn is_openai_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if looks_like_dated_snapshot(&normalized) {
        return false;
    }

    if [
        "embedding",
        "moderation",
        "dall",
        "image",
        "sora",
        "tts",
        "transcribe",
        "whisper",
    ]
    .iter()
    .any(|excluded| normalized.contains(excluded))
    {
        return false;
    }

    normalized.starts_with("gpt-")
        || normalized.starts_with("computer-use")
        || normalized
            .strip_prefix('o')
            .and_then(|suffix| suffix.chars().next())
            .is_some_and(|character| character.is_ascii_digit())
}

fn runtime_model_stage(model_id: &str) -> Option<String> {
    let normalized = model_id.to_ascii_lowercase();

    if normalized.contains("deprecated") {
        return Some("deprecated".to_string());
    }

    if normalized.contains("preview") {
        return Some("preview".to_string());
    }

    None
}

fn create_openai_runtime_model(model_id: &str) -> ProviderRuntimeModel {
    let normalized = model_id.to_ascii_lowercase();
    let voice = normalized.contains("realtime") || normalized.contains("audio");
    let computer_use = normalized.contains("computer-use")
        || normalized.starts_with("gpt-5.5")
        || normalized.starts_with("gpt-5.4");
    let latest_text_model = normalized.starts_with("gpt-5")
        || normalized.starts_with("gpt-4o")
        || normalized.starts_with("gpt-4.1")
        || normalized.starts_with("o3")
        || normalized.starts_with("o4")
        || normalized.starts_with("computer-use");
    let mut recommended_for = Vec::new();

    if latest_text_model {
        recommended_for.push("coding".to_string());
        recommended_for.push("vision".to_string());
    }

    if normalized.contains("mini") || normalized.contains("nano") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    }

    if voice {
        recommended_for.push("voice".to_string());
    }

    if computer_use {
        recommended_for.push("computer-use".to_string());
    }

    ProviderRuntimeModel {
        id: model_id.to_string(),
        label: None,
        stage: runtime_model_stage(model_id),
        description: None,
        best_for: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(latest_text_model),
            tool_use: Some(true),
            reasoning: Some(
                normalized.starts_with("gpt-5")
                    || normalized.starts_with('o')
                    || normalized.contains("reasoning"),
            ),
            streaming: Some(true),
            context_window_tokens: None,
            max_output_tokens: None,
            voice: Some(voice),
            computer_use: Some(computer_use),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    }
}

fn create_anthropic_runtime_model(entry: &serde_json::Value) -> Option<ProviderRuntimeModel> {
    let id = json_string(entry, "id")?;
    let display_name =
        json_string(entry, "display_name").or_else(|| json_string(entry, "displayName"));
    let capabilities = entry.get("capabilities");
    let normalized = id.to_ascii_lowercase();
    let image_input = json_bool_from_keys(
        capabilities,
        &["vision", "image_input", "imageInput", "images"],
    )
    .unwrap_or(true);
    let tool_use = json_bool_from_keys(
        capabilities,
        &["tool_use", "toolUse", "function_calling", "functionCalling"],
    )
    .unwrap_or(true);
    let reasoning = json_bool_from_keys(
        capabilities,
        &[
            "reasoning",
            "thinking",
            "extended_thinking",
            "extendedThinking",
            "adaptive_thinking",
            "adaptiveThinking",
        ],
    )
    .unwrap_or_else(|| normalized.contains("opus") || normalized.contains("sonnet"));
    let mut recommended_for = Vec::new();

    if normalized.contains("opus") || normalized.contains("sonnet") {
        recommended_for.push("coding".to_string());
    }

    if normalized.contains("sonnet") || normalized.contains("haiku") {
        recommended_for.push("fast".to_string());
    }

    if normalized.contains("haiku") {
        recommended_for.push("cheap".to_string());
    }

    if image_input {
        recommended_for.push("vision".to_string());
    }

    Some(ProviderRuntimeModel {
        id: id.clone(),
        label: display_name,
        stage: runtime_model_stage(&id),
        description: None,
        best_for: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(image_input),
            tool_use: Some(tool_use),
            reasoning: Some(reasoning),
            streaming: Some(true),
            context_window_tokens: json_u64(entry, "max_input_tokens")
                .or_else(|| json_u64(entry, "maxInputTokens")),
            max_output_tokens: json_u64(entry, "max_tokens")
                .or_else(|| json_u64(entry, "maxTokens")),
            voice: Some(false),
            computer_use: Some(false),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    })
}

fn create_google_runtime_model(entry: &serde_json::Value) -> Option<ProviderRuntimeModel> {
    let resource_name = json_string(entry, "name")?;
    let id = json_string(entry, "baseModelId").unwrap_or_else(|| {
        resource_name
            .strip_prefix("models/")
            .unwrap_or(resource_name.as_str())
            .to_string()
    });
    let methods = entry
        .get("supportedGenerationMethods")
        .and_then(serde_json::Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if !methods.iter().any(|method| method == "generateContent") {
        return None;
    }

    let normalized = id.to_ascii_lowercase();
    let voice = normalized.contains("tts") || normalized.contains("audio");
    let image_input = !voice
        && !normalized.contains("embedding")
        && !normalized.contains("imagen")
        && !normalized.contains("veo");
    let reasoning = entry
        .get("thinking")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or_else(|| normalized.contains("pro") || normalized.contains("2.5"));
    let mut recommended_for = Vec::new();

    if reasoning || normalized.contains("pro") {
        recommended_for.push("coding".to_string());
    }

    if normalized.contains("flash") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    }

    if image_input {
        recommended_for.push("vision".to_string());
    }

    if voice {
        recommended_for.push("voice".to_string());
    }

    Some(ProviderRuntimeModel {
        id,
        label: json_string(entry, "displayName"),
        stage: runtime_model_stage(&resource_name),
        description: json_string(entry, "description"),
        best_for: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(image_input),
            tool_use: Some(true),
            reasoning: Some(reasoning),
            streaming: Some(true),
            context_window_tokens: json_u64(entry, "inputTokenLimit"),
            max_output_tokens: json_u64(entry, "outputTokenLimit"),
            voice: Some(voice),
            computer_use: Some(false),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    })
}

async fn fetch_openai_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = client
        .get("https://api.openai.com/v1/models")
        .bearer_auth(api_key)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Failed to parse OpenAI model list: {error}"))?;
    let mut models = payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| json_string(entry, "id"))
                .filter(|id| is_openai_runtime_model(id))
                .map(|id| create_openai_runtime_model(&id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}

async fn fetch_anthropic_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = client
        .get("https://api.anthropic.com/v1/models?limit=1000")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Failed to parse Anthropic model list: {error}"))?;
    let mut models = payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(create_anthropic_runtime_model)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}

async fn fetch_google_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = client
        .get("https://generativelanguage.googleapis.com/v1beta/models")
        .query(&[("key", api_key), ("pageSize", "1000")])
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Failed to parse Google model list: {error}"))?;
    let mut by_id = HashMap::<String, ProviderRuntimeModel>::new();

    if let Some(entries) = payload.get("models").and_then(serde_json::Value::as_array) {
        for model in entries.iter().filter_map(create_google_runtime_model) {
            by_id.entry(model.id.clone()).or_insert(model);
        }
    }

    let mut models = by_id.into_values().collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}

async fn fetch_provider_model_catalog(
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
pub async fn get_user_agent_limits_settings() -> Result<UserAgentLimitsSettings, String> {
    load_user_agent_limits_settings()
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
    } else if is_valid_mode(config.default_mode.as_deref()) {
        config
            .default_mode
            .as_deref()
            .unwrap_or("machdoch")
            .trim()
            .to_string()
    } else {
        "machdoch".to_string()
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

    let offline = matches!(
        env.get("MACHDOCH_OFFLINE").map(String::as_str),
        Some("true")
    ) || profile
        .and_then(|entry| entry.offline)
        .or(config.offline)
        .unwrap_or(false);

    Ok(RuntimeSnapshot {
        workspace_root: resolved_workspace_root,
        workspace_config_path,
        active_profile,
        available_profiles: get_available_profiles(&config.profiles),
        mode,
        provider,
        model,
        offline,
        agent_limits: resolve_runtime_agent_limits(&user_config, &config, profile, &env),
        compatibility: resolve_compatibility(&config, profile),
        provider_availability,
        web_search: RuntimeWebSearchConfig {
            active_provider: web_search_active_provider,
            provider_availability: web_search_provider_availability,
        },
        ui_control: crate::ui_control::detect_ui_control_availability(),
    })
}
