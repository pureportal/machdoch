use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt as _;
use unicode_normalization::UnicodeNormalization as _;
use zeroize::Zeroizing;

use crate::runtime_contract_generated::{
    DEFAULT_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    DEFAULT_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_ENABLED,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_HIDE_WHEN_FULLSCREEN,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    DEFAULT_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS, DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
    DEFAULT_MAX_EXECUTOR_TURNS, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_MODEL_PROVIDER,
    DEFAULT_USER_AGENT_LIMITS_INFINITE, DEFAULT_USER_INTERNAL_TASK_MODEL_REASONING,
    DEFAULT_USER_REVIEW_MODEL_MODE, MAX_CONFIGURED_AUTOPILOT_ITERATIONS,
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
    REASONING_MODES, RUN_MODES, USER_API_PROVIDERS, USER_REVIEW_MODEL_MODES,
    USER_WEB_SEARCH_PROVIDERS, VALID_AUDIO_AI_PROVIDERS, VALID_MODEL_PROVIDERS,
    VALID_WEB_SEARCH_PROVIDERS,
};
use crate::{
    cooperative_file_lock::{acquire_cooperative_file_lock, CooperativeFileLock},
    runtime_snapshot::{get_user_config_directory, user_config},
};

use super::contract::{
    CategoryAvailabilityState, CategorySnapshot, CategorySnapshotData, CategoryStatus,
    FileSnapshotEntry, SettingsCategoryId, SnapshotAvailability, CATEGORY_SCHEMA_VERSION,
};

mod api_keys;
mod global_mcp;
mod global_ralph;
mod shared;

pub(crate) use shared::{
    category_data_json, category_file_entries, has_file_ancestor_collision, relative_path_to_wire,
    validate_wire_path, zeroize_envelope, zeroize_json_value, zeroize_snapshot,
    zeroize_snapshot_availability, zeroize_snapshots,
};
use shared::{create_file_snapshot, create_json_snapshot, sha256_hex, MAX_RELATIVE_PATH_DEPTH};

pub(crate) fn ralph_flow_id_from_path(path: &str) -> Option<&str> {
    global_ralph::flow_id_from_path(path)
}

pub(crate) fn validate_global_ralph_preferences_value(value: &Value) -> Result<(), String> {
    global_ralph::validate_preferences(value)
}

pub(crate) const MAX_TOTAL_PLAINTEXT_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_TOTAL_ITEMS: usize = 2_000;
pub(crate) const MAX_TEXT_FILE_BYTES: u64 = 128 * 1024;
pub(crate) const MAX_USER_CONFIG_BYTES: u64 = 8 * 1024 * 1024;
pub(crate) const MAX_MCP_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const MAX_RALPH_FLOW_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CONTEXT_PACKS: usize = 160;
const MAX_CONTEXT_PACK_NAME_CHARS: usize = 72;
const MAX_CONTEXT_PACK_TEXT_CHARS: usize = 8_000;
const MAX_CONTEXT_PACK_VARIABLES: usize = 12;
const MAX_CONTEXT_PACK_VARIABLE_CHARS: usize = 40;
const MAX_CONTEXT_PACK_TRIGGERS: usize = 16;
const MAX_CONTEXT_PACK_TRIGGER_CHARS: usize = 96;
const MAX_CONTEXT_PACK_ID_CHARS: usize = 256;
const MAX_CONTEXT_PACK_ATTACHMENT_TEXT_CHARS: usize = 4_096;
const RALPH_CORE_VALIDATION_TIMEOUT: Duration = Duration::from_secs(60);
const STORE_FILE: &str = "machdoch-shell-state.json";
const APPEARANCE_STORAGE_KEY: &str = "machdoch.desktop.appearance-state";
const MCP_MARKETPLACE_STORAGE_KEY: &str = "machdoch.desktop.mcp-marketplace-state";
const RUNNING_TASK_MESSAGE_ACTION_STORAGE_KEY: &str =
    "machdoch.desktop.running-task-message-action";
const RALPH_SETTINGS_STORAGE_KEY: &str = "machdoch.desktop.ralph-settings";
const CHAT_VOICE_PREFERENCE_ITEM_COUNT: u32 = 10;
const RALPH_PREFERENCE_ITEM_COUNT: u32 = 8;
const MIN_VOICE_RATE: f64 = 0.8;
const MAX_VOICE_RATE: f64 = 1.4;
const MAX_MODEL_ID_CHARS: usize = 512;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn path_entry_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("A global settings path could not be inspected.".to_string()),
    }
}

fn load_user_config_value() -> Result<Value, String> {
    let root = get_user_config_directory()?;
    verify_safe_directory_if_present(&root)?;
    let path = root.join("user-config.json");
    if path_entry_exists(&path)? {
        verify_regular_contained_file(&root, &path, MAX_USER_CONFIG_BYTES)?;
    }
    user_config::load_user_config_value_at_path(&path)
        .map_err(|_| "The global user settings are unavailable or invalid.".to_string())
}

fn object_or_empty(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn enum_string_or(value: Option<&Value>, allowed: &[&str], fallback: &str) -> Value {
    Value::String(
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|entry| allowed.contains(entry))
            .unwrap_or(fallback)
            .to_string(),
    )
}

fn normalized_review_model(value: &Map<String, Value>) -> Value {
    let mode = value
        .get("mode")
        .and_then(Value::as_str)
        .filter(|mode| USER_REVIEW_MODEL_MODES.contains(mode))
        .unwrap_or(DEFAULT_USER_REVIEW_MODEL_MODE);
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|provider| VALID_MODEL_PROVIDERS.contains(provider));
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty());
    match (mode, provider, model) {
        ("dedicated", Some(provider), Some(model)) => {
            json!({ "mode": "dedicated", "provider": provider, "model": model })
        }
        _ => json!({ "mode": "base", "provider": null, "model": null }),
    }
}

fn normalized_internal_task_model(value: &Map<String, Value>) -> Value {
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|provider| VALID_MODEL_PROVIDERS.contains(provider));
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty());
    let reasoning = value
        .get("reasoning")
        .and_then(Value::as_str)
        .filter(|reasoning| REASONING_MODES.contains(reasoning))
        .unwrap_or(DEFAULT_USER_INTERNAL_TASK_MODEL_REASONING);

    match (provider, model) {
        (Some(provider), Some(model)) => {
            json!({ "provider": provider, "model": model, "reasoning": reasoning })
        }
        _ => json!({ "provider": null, "model": null, "reasoning": reasoning }),
    }
}

fn bool_or(value: Option<&Value>, fallback: bool) -> Value {
    Value::Bool(value.and_then(Value::as_bool).unwrap_or(fallback))
}

fn u64_clamped(value: Option<&Value>, fallback: u64, minimum: u64, maximum: u64) -> Value {
    Value::Number(
        value
            .and_then(Value::as_u64)
            .unwrap_or(fallback)
            .clamp(minimum, maximum)
            .into(),
    )
}

fn f64_clamped(value: Option<&Value>, fallback: f64, minimum: f64, maximum: f64) -> Value {
    let normalized = value
        .and_then(Value::as_f64)
        .filter(|entry| entry.is_finite())
        .unwrap_or(fallback)
        .clamp(minimum, maximum);
    serde_json::Number::from_f64(normalized)
        .map(Value::Number)
        .unwrap_or_else(|| json!(fallback))
}

fn default_model_for_provider(provider: &str) -> &'static str {
    DEFAULT_MODEL_BY_PROVIDER
        .iter()
        .find_map(|(candidate, model)| (*candidate == provider).then_some(*model))
        .unwrap_or("auto")
}

fn valid_model_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.trim() == value
        && value.chars().count() <= MAX_MODEL_ID_CHARS
        && !value.chars().any(char::is_control)
}

fn normalized_runtime_provider(value: Option<&Value>) -> &'static str {
    value
        .and_then(Value::as_str)
        .and_then(|provider| {
            VALID_MODEL_PROVIDERS
                .iter()
                .copied()
                .find(|candidate| *candidate == provider)
        })
        .unwrap_or(DEFAULT_MODEL_PROVIDER)
}

fn normalized_model(value: Option<&Value>, provider: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|model| valid_model_id(model))
        .unwrap_or_else(|| default_model_for_provider(provider))
        .to_string()
}

fn nullable_enum(value: Option<&Value>, allowed: &[&str]) -> Value {
    value
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .map(|value| Value::String(value.to_string()))
        .unwrap_or(Value::Null)
}

fn normalized_provider_enrollment(value: Option<&Value>) -> Value {
    let root = object_or_empty(value);
    let mcp = object_or_empty(root.get("mcp"));
    let sync = object_or_empty(root.get("persistentSync"));
    let providers = object_or_empty(root.get("providers"));
    let provider_enabled = |id: &str| {
        let value = object_or_empty(providers.get(id));
        json!({ "enabled": value.get("enabled").and_then(Value::as_bool).unwrap_or(true) })
    };

    json!({
        "schemaVersion": 1,
        "enabled": root.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "mcp": {
            "unmanagedNative": mcp.get("unmanagedNative").and_then(Value::as_str).filter(|value| ["adopt", "allow", "fail"].contains(value)).unwrap_or("allow"),
            "approvals": "never",
        },
        "persistentSync": {
            "enabled": sync.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            "watch": sync.get("watch").and_then(Value::as_bool).unwrap_or(true),
            "debounceMs": sync.get("debounceMs").and_then(Value::as_u64).unwrap_or(500).clamp(50, 60_000),
            "fullRescanIntervalMs": sync.get("fullRescanIntervalMs").and_then(Value::as_u64).unwrap_or(600_000).clamp(10_000, 86_400_000),
        },
        "providers": {
            "codex-cli": provider_enabled("codex-cli"),
            "claude-cli": provider_enabled("claude-cli"),
            "copilot-cli": provider_enabled("copilot-cli"),
        }
    })
}

fn snapshot_agent_provider_preferences() -> Result<CategorySnapshot, String> {
    let root = load_user_config_value()?;
    let root = root
        .as_object()
        .ok_or_else(|| "Global user settings are invalid.".to_string())?;
    let web_search = object_or_empty(root.get("webSearch"));
    let voice = object_or_empty(root.get("voice"));
    let speech = object_or_empty(root.get("speechToText"));
    let limits = object_or_empty(root.get("agentLimits"));
    let review = object_or_empty(root.get("reviewModel"));
    let internal_task = object_or_empty(root.get("internalTaskModel"));

    let value = json!({
        "webSearchActiveProvider": enum_string_or(web_search.get("activeProvider"), &VALID_WEB_SEARCH_PROVIDERS, "none"),
        "voiceActiveProvider": enum_string_or(voice.get("activeProvider"), &VALID_AUDIO_AI_PROVIDERS, "none"),
        "speechToTextActiveProvider": enum_string_or(speech.get("activeProvider"), &VALID_AUDIO_AI_PROVIDERS, "none"),
        "agentLimits": {
            "infinite": bool_or(limits.get("infinite"), DEFAULT_USER_AGENT_LIMITS_INFINITE),
            "executorTurns": u64_clamped(limits.get("executorTurns"), u64::from(DEFAULT_MAX_EXECUTOR_TURNS), 1, u64::from(MAX_CONFIGURED_EXECUTOR_TURNS)),
            "autopilotExecutorIterations": u64_clamped(limits.get("autopilotExecutorIterations"), u64::from(DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS), 1, u64::from(MAX_CONFIGURED_AUTOPILOT_ITERATIONS)),
        },
        "reviewModel": normalized_review_model(&review),
        "internalTaskModel": normalized_internal_task_model(&internal_task),
        "providerEnrollment": normalized_provider_enrollment(root.get("providerEnrollment")),
    });
    validate_agent_provider_value(&value)?;
    create_json_snapshot(
        SettingsCategoryId::AgentProviderPreferences,
        value,
        7,
        false,
    )
}

fn normalize_appearance(value: Option<Value>) -> Value {
    let root = value.as_ref().and_then(Value::as_object);
    let select = |key: &str, allowed: &[&str], fallback: &str| {
        root.and_then(|value| value.get(key))
            .and_then(Value::as_str)
            .filter(|value| allowed.contains(value))
            .unwrap_or(fallback)
            .to_string()
    };

    json!({
        "version": 1,
        "theme": select("theme", &["dark", "light"], "dark"),
        "density": select("density", &["comfortable", "compact"], "comfortable"),
        "accent": select("accent", &["sky", "emerald", "violet", "amber"], "sky"),
        "quickChatBubbleStyle": select("quickChatBubbleStyle", &["classic", "glass", "pulse", "orbit"], "classic"),
    })
}

fn snapshot_desktop_appearance<R: Runtime>(app: &AppHandle<R>) -> Result<CategorySnapshot, String> {
    let root = load_user_config_value()?;
    let root = root
        .as_object()
        .ok_or_else(|| "Global user settings are invalid.".to_string())?;
    let desktop = object_or_empty(root.get("desktop"));
    let store = app
        .store(STORE_FILE)
        .map_err(|_| "Desktop preferences are unavailable.".to_string())?;
    let appearance = normalize_appearance(store.get(APPEARANCE_STORAGE_KEY));
    let value = json!({
        "desktop": {
            "assistantBubbleEnabled": bool_or(desktop.get("assistantBubbleEnabled"), DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_ENABLED),
            "assistantBubbleHideWhenFullscreen": bool_or(desktop.get("assistantBubbleHideWhenFullscreen"), DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_HIDE_WHEN_FULLSCREEN),
            "assistantBubbleTemporarilyHideSeconds": u64_clamped(desktop.get("assistantBubbleTemporarilyHideSeconds"), u64::from(DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS), u64::from(MIN_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS), u64::from(MAX_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS)),
            "aiContextMaxMessages": u64_clamped(desktop.get("aiContextMaxMessages"), u64::from(DEFAULT_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES), u64::from(MIN_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES), u64::from(MAX_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES)),
            "inactiveSessionArchiveDays": u64_clamped(desktop.get("inactiveSessionArchiveDays"), u64::from(DEFAULT_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS), u64::from(MIN_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS), u64::from(MAX_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS)),
            "archivedSessionRetentionDays": u64_clamped(desktop.get("archivedSessionRetentionDays"), u64::from(DEFAULT_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS), u64::from(MIN_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS), u64::from(MAX_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS)),
            "quickVoiceSilenceSeconds": f64_clamped(desktop.get("quickVoiceSilenceSeconds"), DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS, MIN_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS, MAX_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS),
            "quickVoiceMaxMessages": u64_clamped(desktop.get("quickVoiceMaxMessages"), u64::from(DEFAULT_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES), u64::from(MIN_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES), u64::from(MAX_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES)),
        },
        "appearance": appearance,
    });
    validate_desktop_appearance_value(&value)?;
    create_json_snapshot(SettingsCategoryId::DesktopAppearance, value, 9, false)
}

fn snapshot_global_memory() -> Result<CategorySnapshot, String> {
    let root = load_user_config_value()?;
    let root = root
        .as_object()
        .ok_or_else(|| "Global user settings are invalid.".to_string())?;
    let memory = object_or_empty(root.get("memory"));
    let entries = memory
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.get("scope").and_then(Value::as_str) == Some("global"))
        .collect::<Vec<_>>();
    let value = json!({
        "globalEnabled": memory.get("globalEnabled").and_then(Value::as_bool).unwrap_or(false),
        "entries": entries,
    });
    validate_memory_value(&value)?;
    let count = value["entries"].as_array().map_or(0, Vec::len);
    let empty = count == 0 && !value["globalEnabled"].as_bool().unwrap_or(false);
    create_json_snapshot(
        SettingsCategoryId::GlobalMemory,
        value,
        u32::try_from(count).unwrap_or(u32::MAX),
        empty,
    )
}

pub(crate) fn chat_voice_preferences_from_sources<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Value, String> {
    let shell_state = crate::shell_state::load_shell_state_for_settings_transfer(app)
        .map_err(|_| "Chat and voice preferences are unavailable.".to_string())?;
    let root = shell_state
        .as_object()
        .ok_or_else(|| "The persisted shell state is invalid.".to_string())?;
    let voice = root.get("voice").and_then(Value::as_object);
    let provider = normalized_runtime_provider(root.get("lastSelectedProvider"));
    let stored_models = root
        .get("lastSelectedModelByProvider")
        .and_then(Value::as_object);
    let mut models = Map::new();
    if let Some(stored_models) = stored_models {
        for (candidate, model) in stored_models {
            if VALID_MODEL_PROVIDERS.contains(&candidate.as_str())
                && model.as_str().is_some_and(valid_model_id)
            {
                models.insert(candidate.clone(), model.clone());
            }
        }
    }
    models
        .entry(provider.to_string())
        .or_insert_with(|| Value::String(default_model_for_provider(provider).to_string()));

    let store = app
        .store(STORE_FILE)
        .map_err(|_| "Chat preferences are unavailable.".to_string())?;
    let running_task_message_action = store
        .get(RUNNING_TASK_MESSAGE_ACTION_STORAGE_KEY)
        .and_then(|value| value.as_str().map(str::to_string))
        .filter(|value| ["steer", "stop-and-send", "queue"].contains(&value.as_str()))
        .unwrap_or_else(|| "queue".to_string());
    let value = json!({
        "voice": {
            "autoSpeakResponses": voice
                .and_then(|voice| voice.get("autoSpeakResponses"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "rate": f64_clamped(
                voice.and_then(|voice| voice.get("rate")),
                1.0,
                MIN_VOICE_RATE,
                MAX_VOICE_RATE,
            ),
        },
        "newChat": {
            "provider": provider,
            "models": models,
            "mode": nullable_enum(root.get("lastSelectedMode"), &RUN_MODES),
            "reasoning": nullable_enum(root.get("lastSelectedReasoning"), &REASONING_MODES),
            "sessionMemoryEnabled": root
                .get("lastSelectedSessionMemoryEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            "useGlobalMemory": root
                .get("lastSelectedUseGlobalMemory")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            "uiControlEnabled": root
                .get("lastSelectedUiControlEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "runningTaskMessageAction": running_task_message_action,
    });
    validate_chat_voice_preferences_value(&value)?;
    Ok(value)
}

fn snapshot_chat_voice_preferences<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<CategorySnapshot, String> {
    create_json_snapshot(
        SettingsCategoryId::ChatVoicePreferences,
        chat_voice_preferences_from_sources(app)?,
        CHAT_VOICE_PREFERENCE_ITEM_COUNT,
        false,
    )
}

fn context_pack_scope(value: &Value) -> Result<bool, String> {
    let pack = value
        .as_object()
        .ok_or_else(|| "A context pack is invalid.".to_string())?;
    match pack.get("workspace") {
        Some(Value::Null) => Ok(true),
        Some(Value::String(workspace))
            if !workspace.trim().is_empty()
                && workspace.chars().count() <= MAX_CONTEXT_PACK_ATTACHMENT_TEXT_CHARS
                && !workspace.chars().any(char::is_control) =>
        {
            Ok(false)
        }
        _ => Err("A context pack has an invalid scope.".to_string()),
    }
}

fn context_pack_id(value: &Value) -> Result<&str, String> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "A context pack is missing its id.".to_string())?;
    if id.is_empty()
        || id.trim() != id
        || id.chars().count() > MAX_CONTEXT_PACK_ID_CHARS
        || id.chars().any(char::is_control)
    {
        return Err("A context pack has an invalid id.".to_string());
    }
    Ok(id)
}

fn shell_context_packs(value: &Value) -> Result<Vec<Value>, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "The persisted shell state is invalid.".to_string())?;
    match root.get("contextPacks") {
        None => Ok(Vec::new()),
        Some(Value::Array(packs)) => Ok(packs.clone()),
        Some(_) => Err("The persisted context-pack collection is invalid.".to_string()),
    }
}

pub(crate) fn global_context_packs_from_shell_state(
    shell_state: &Value,
) -> Result<Vec<Value>, String> {
    let packs = shell_context_packs(shell_state)?;
    let mut ids = HashSet::new();
    let mut global = Vec::new();
    for pack in packs {
        let id = context_pack_id(&pack)?.to_string();
        if !ids.insert(id) {
            return Err("Context pack ids must be unique.".to_string());
        }
        if context_pack_scope(&pack)? {
            global.push(pack);
        }
    }
    Ok(global)
}

pub(crate) fn replace_global_context_packs(
    shell_state: &Value,
    incoming_global: &[Value],
) -> Result<Vec<Value>, String> {
    validate_global_context_packs_value(&json!({ "contextPacks": incoming_global }))?;
    let incoming_ids = incoming_global
        .iter()
        .map(context_pack_id)
        .collect::<Result<HashSet<_>, _>>()?;
    let mut context_packs = incoming_global.to_vec();
    let mut existing_ids = HashSet::new();
    for pack in shell_context_packs(shell_state)? {
        let id = context_pack_id(&pack)?;
        if !existing_ids.insert(id.to_string()) {
            return Err("The receiver context pack ids are not unique.".to_string());
        }
        if context_pack_scope(&pack)? {
            continue;
        }
        if incoming_ids.contains(id) {
            return Err(
                "An imported global context pack conflicts with a workspace pack id.".to_string(),
            );
        }
        context_packs.push(pack);
    }
    Ok(context_packs)
}

fn snapshot_global_context_packs<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<CategorySnapshot, String> {
    let shell_state = crate::shell_state::load_shell_state_for_settings_transfer(app)
        .map_err(|_| "Global context packs are unavailable.".to_string())?;
    let context_packs = global_context_packs_from_shell_state(&shell_state)?;
    let value = json!({ "contextPacks": context_packs });
    validate_global_context_packs_value(&value)?;
    let count = value["contextPacks"].as_array().map_or(0, Vec::len);
    create_json_snapshot(
        SettingsCategoryId::GlobalContextPacks,
        value,
        u32::try_from(count).unwrap_or(u32::MAX),
        count == 0,
    )
}

#[cfg(unix)]
fn has_multiple_hard_links(_path: &Path, metadata: &fs::Metadata) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt as _;
    Ok(metadata.nlink() > 1)
}

#[cfg(windows)]
fn has_multiple_hard_links(path: &Path, _metadata: &fs::Metadata) -> Result<bool, String> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let file = fs::File::open(path)
        .map_err(|_| "A selected settings file could not be opened safely.".to_string())?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the file owns a valid handle for the duration of the call and
    // `information` points to writable storage of the required Win32 type.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if succeeded == 0 {
        return Err("A selected settings file's link count could not be inspected.".to_string());
    }
    Ok(information.nNumberOfLinks > 1)
}

#[cfg(not(any(unix, windows)))]
fn has_multiple_hard_links(_path: &Path, _metadata: &fs::Metadata) -> Result<bool, String> {
    Ok(false)
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn verify_safe_directory_if_present(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.is_dir()
                && !metadata.file_type().is_symlink()
                && !is_windows_reparse_point(&metadata) =>
        {
            Ok(())
        }
        Ok(_) => Err("The global settings directory is linked or invalid.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("The global settings directory could not be inspected.".to_string()),
    }
}

pub(crate) fn verify_unlinked_directory_chain(
    root: &Path,
    directory: &Path,
) -> Result<bool, String> {
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| "A global settings directory escaped its root.".to_string())?;
    let mut current = root.to_path_buf();
    let components = std::iter::once(None).chain(relative.components().map(Some));
    for component in components {
        if let Some(component) = component {
            let Component::Normal(component) = component else {
                return Err("A global settings directory has an unsafe path.".to_string());
            };
            current.push(component);
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata)
                if metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && !is_windows_reparse_point(&metadata) => {}
            Ok(_) => {
                return Err(
                    "A global settings directory or one of its parents is linked or invalid."
                        .to_string(),
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("A global settings directory could not be inspected.".to_string()),
        }
    }
    Ok(true)
}

fn verify_regular_contained_file(
    root: &Path,
    path: &Path,
    maximum_bytes: u64,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "A selected settings file could not be inspected.".to_string())?;
    let multiple_hard_links = has_multiple_hard_links(path, &metadata)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || is_windows_reparse_point(&metadata)
        || multiple_hard_links
    {
        return Err("A selected settings file is linked or is not a regular file.".to_string());
    }
    if metadata.len() > maximum_bytes {
        return Err("A selected settings file exceeds the transfer limit.".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "The selected settings directory could not be resolved.".to_string())?;
    let canonical_path = path
        .canonicalize()
        .map_err(|_| "A selected settings file could not be resolved.".to_string())?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("A selected settings file escapes its global settings directory.".to_string());
    }
    Ok(())
}

fn validate_frontmatter(content: &str) -> Result<(), String> {
    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        let mut lines = content.lines();
        let _ = lines.next();
        if !lines.any(|line| line.trim() == "---") {
            return Err("A customization file has incomplete frontmatter.".to_string());
        }
    }
    Ok(())
}

fn collect_tree_files(
    global_root: &Path,
    scan_root: &Path,
    relative_prefix: &str,
    suffix: &str,
) -> Result<Vec<FileSnapshotEntry>, String> {
    if !verify_unlinked_directory_chain(global_root, scan_root)? {
        return Ok(Vec::new());
    }

    let mut pending = vec![scan_root.to_path_buf()];
    let mut files = Vec::new();
    let mut visited_entries = 0_usize;
    let prefix_depth = relative_prefix
        .split('/')
        .filter(|component| !component.is_empty())
        .count();
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|_| "A global customization directory could not be read.".to_string())?;
        for entry in entries {
            visited_entries = visited_entries.saturating_add(1);
            if visited_entries > MAX_TOTAL_ITEMS.saturating_mul(4) {
                return Err("A global customization tree contains too many entries.".to_string());
            }
            let entry =
                entry.map_err(|_| "A global customization entry could not be read.".to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| "A global customization entry could not be inspected.".to_string())?;
            if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
                return Err("A global customization tree contains a linked entry.".to_string());
            }
            if metadata.is_dir() {
                let depth = path
                    .strip_prefix(scan_root)
                    .map_err(|_| "A customization directory escaped its global root.".to_string())?
                    .components()
                    .count()
                    .saturating_add(prefix_depth);
                if depth >= MAX_RELATIVE_PATH_DEPTH {
                    return Err("A global customization tree is too deeply nested.".to_string());
                }
                pending.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(suffix) {
                continue;
            }
            verify_regular_contained_file(global_root, &path, MAX_TEXT_FILE_BYTES)?;
            let relative = path
                .strip_prefix(scan_root)
                .map_err(|_| "A customization path is outside its global directory.".to_string())?;
            let relative = relative_path_to_wire(relative)?;
            let wire_path = if relative_prefix.is_empty() {
                relative
            } else {
                format!("{relative_prefix}/{relative}")
            };
            validate_wire_path(&wire_path)?;
            let content = fs::read_to_string(&path)
                .map_err(|_| "A customization file must contain valid UTF-8 text.".to_string())?;
            validate_frontmatter(&content)?;
            files.push(FileSnapshotEntry {
                relative_path: wire_path,
                sha256: sha256_hex(content.as_bytes()),
                utf8_content: content,
            });
        }
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

fn snapshot_global_prompts() -> Result<CategorySnapshot, String> {
    let root = get_user_config_directory()?;
    let entries = collect_tree_files(&root, &root.join("prompts"), "prompts", ".prompt.md")?;
    create_file_snapshot(SettingsCategoryId::GlobalPrompts, entries)
}

fn snapshot_category_with_exported_at<R: Runtime>(
    app: &AppHandle<R>,
    id: SettingsCategoryId,
    _exported_at: &str,
) -> SnapshotAvailability {
    let result = match id {
        SettingsCategoryId::ApiKeys => api_keys::snapshot(),
        SettingsCategoryId::AgentProviderPreferences => snapshot_agent_provider_preferences(),
        SettingsCategoryId::DesktopAppearance => snapshot_desktop_appearance(app),
        SettingsCategoryId::ChatVoicePreferences => snapshot_chat_voice_preferences(app),
        SettingsCategoryId::GlobalMemory => snapshot_global_memory(),
        SettingsCategoryId::GlobalPrompts => snapshot_global_prompts(),
        SettingsCategoryId::GlobalContextPacks => snapshot_global_context_packs(app),
        SettingsCategoryId::GlobalMcp => global_mcp::snapshot(app),
        SettingsCategoryId::GlobalRalphPreferences => global_ralph::snapshot_preferences(app),
        SettingsCategoryId::GlobalRalphFlows => global_ralph::snapshot_flows(),
    };

    match result {
        Ok(mut snapshot) => match validate_category_snapshot(&snapshot) {
            Ok(()) => SnapshotAvailability::Available(snapshot),
            Err(reason) => {
                zeroize_snapshot(&mut snapshot);
                SnapshotAvailability::Unavailable(reason)
            }
        },
        Err(reason) => SnapshotAvailability::Unavailable(reason),
    }
}

pub(crate) fn snapshot_category<R: Runtime>(
    app: &AppHandle<R>,
    id: SettingsCategoryId,
) -> SnapshotAvailability {
    snapshot_category_with_exported_at(app, id, &Utc::now().to_rfc3339())
}

pub(crate) fn category_resource_lock_paths(
    root: &Path,
    categories: &BTreeSet<SettingsCategoryId>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if categories.iter().any(|category| {
        matches!(
            category,
            SettingsCategoryId::ApiKeys
                | SettingsCategoryId::AgentProviderPreferences
                | SettingsCategoryId::DesktopAppearance
                | SettingsCategoryId::GlobalMemory
        )
    }) {
        paths.push(root.join("user-config.json"));
    }
    if categories.contains(&SettingsCategoryId::GlobalMcp) {
        paths.push(root.join("mcp.json"));
        paths.push(root.join(STORE_FILE));
    }
    if categories.contains(&SettingsCategoryId::DesktopAppearance) {
        paths.push(root.join(STORE_FILE));
    }
    if categories.contains(&SettingsCategoryId::ChatVoicePreferences)
        || categories.contains(&SettingsCategoryId::GlobalRalphPreferences)
    {
        paths.push(root.join(STORE_FILE));
    }
    if categories.contains(&SettingsCategoryId::GlobalPrompts) {
        paths.push(root.join("prompts.transfer-boundary"));
    }
    if categories.contains(&SettingsCategoryId::GlobalRalphFlows) {
        paths.push(
            root.join("ralph")
                .join("flows")
                .join(".ralph-flow-directory"),
        );
    }
    paths.sort();
    paths.dedup();
    paths
}

pub(crate) fn provider_enrollment_reconcile_lock_path(
    root: &Path,
    categories: &BTreeSet<SettingsCategoryId>,
) -> Option<PathBuf> {
    categories
        .iter()
        .any(|category| {
            matches!(
                category,
                SettingsCategoryId::AgentProviderPreferences | SettingsCategoryId::GlobalMcp
            )
        })
        .then(|| root.join("provider-enrollment").join("reconcile.state"))
}

fn acquire_snapshot_locks(
    root: &Path,
    selected: &BTreeSet<SettingsCategoryId>,
) -> Result<Vec<CooperativeFileLock>, String> {
    let mut locks = Vec::new();
    // Snapshots only read provider-enrollment inputs, so they need the resource
    // locks that exclude writers but not the coordinator used by reconciliation.
    // Transactions still take that coordinator before changing multiple inputs.
    for path in category_resource_lock_paths(root, selected) {
        locks.push(acquire_cooperative_file_lock(&path)?);
    }
    Ok(locks)
}

fn capture_consistent_snapshots(
    selected: &BTreeSet<SettingsCategoryId>,
    snapshot: impl Fn(SettingsCategoryId, &str) -> SnapshotAvailability,
) -> Result<BTreeMap<SettingsCategoryId, SnapshotAvailability>, String> {
    let exported_at = Utc::now().to_rfc3339();
    let capture = || {
        selected
            .iter()
            .copied()
            .map(|id| (id, snapshot(id, &exported_at)))
            .collect::<BTreeMap<_, _>>()
    };
    let mut first = capture();
    let mut second = capture();
    if first != second {
        zeroize_snapshots(&mut first);
        zeroize_snapshots(&mut second);
        return Err("SETTINGS_CHANGED_DURING_INSPECTION".to_string());
    }
    zeroize_snapshots(&mut second);
    Ok(first)
}

pub(crate) fn snapshot_selected<R: Runtime>(
    app: &AppHandle<R>,
    selected: &BTreeSet<SettingsCategoryId>,
) -> Result<BTreeMap<SettingsCategoryId, SnapshotAvailability>, String> {
    let root = get_user_config_directory()?;
    let _ = verify_unlinked_directory_chain(&root, &root)?;
    let _locks = acquire_snapshot_locks(&root, selected)?;
    capture_consistent_snapshots(selected, |id, exported_at| {
        snapshot_category_with_exported_at(app, id, exported_at)
    })
}

pub(crate) fn create_category_statuses(
    selected: &BTreeSet<SettingsCategoryId>,
    snapshots: &BTreeMap<SettingsCategoryId, SnapshotAvailability>,
) -> Vec<CategoryStatus> {
    SettingsCategoryId::ALL
        .into_iter()
        .map(|id| {
            let mut status = CategoryStatus::catalog(id);
            status.selected = selected.contains(&id);
            if let Some(snapshot) = snapshots.get(&id) {
                match snapshot {
                    SnapshotAvailability::Available(snapshot) => {
                        status.availability = if snapshot.replacement == "empty" {
                            CategoryAvailabilityState::Empty
                        } else {
                            CategoryAvailabilityState::Available
                        };
                        status.item_count = snapshot.item_count;
                        status.byte_count = snapshot.plaintext_bytes;
                    }
                    SnapshotAvailability::Unavailable(reason) => {
                        status.availability = CategoryAvailabilityState::Unavailable;
                        status.reason = Some(reason.clone());
                    }
                }
            }
            status
        })
        .collect()
}

pub(crate) fn validate_category_snapshot(snapshot: &CategorySnapshot) -> Result<(), String> {
    if snapshot.schema_version != CATEGORY_SCHEMA_VERSION {
        return Err("A category uses an unsupported schema version.".to_string());
    }
    if !matches!(snapshot.replacement.as_str(), "value" | "empty") {
        return Err("A category has an invalid replacement mode.".to_string());
    }
    let bytes = Zeroizing::new(
        serde_json::to_vec(&snapshot.data)
            .map_err(|_| "A category could not be serialized for verification.".to_string())?,
    );
    if bytes.len() as u64 != snapshot.plaintext_bytes || sha256_hex(&bytes) != snapshot.sha256 {
        return Err("A category failed its completeness check.".to_string());
    }
    match (snapshot.id, &snapshot.data) {
        (SettingsCategoryId::ApiKeys, CategorySnapshotData::Json(value)) => {
            api_keys::validate(value)
        }
        (SettingsCategoryId::AgentProviderPreferences, CategorySnapshotData::Json(value)) => {
            validate_agent_provider_value(value)
        }
        (SettingsCategoryId::DesktopAppearance, CategorySnapshotData::Json(value)) => {
            validate_desktop_appearance_value(value)
        }
        (SettingsCategoryId::ChatVoicePreferences, CategorySnapshotData::Json(value)) => {
            validate_chat_voice_preferences_value(value)
        }
        (SettingsCategoryId::GlobalMemory, CategorySnapshotData::Json(value)) => {
            validate_memory_value(value)
        }
        (SettingsCategoryId::GlobalContextPacks, CategorySnapshotData::Json(value)) => {
            validate_global_context_packs_value(value)
        }
        (SettingsCategoryId::GlobalMcp, CategorySnapshotData::Json(value)) => {
            global_mcp::validate(value)
        }
        (SettingsCategoryId::GlobalRalphPreferences, CategorySnapshotData::Json(value)) => {
            validate_global_ralph_preferences_value(value)
        }
        (SettingsCategoryId::GlobalPrompts, CategorySnapshotData::Files(entries)) => {
            validate_file_entries(snapshot.id, entries)
        }
        (SettingsCategoryId::GlobalRalphFlows, CategorySnapshotData::Files(entries)) => {
            validate_file_entries(snapshot.id, entries)
        }
        _ => Err("A category payload has an invalid representation.".to_string()),
    }?;

    let (item_count, empty) = snapshot_semantics(snapshot)?;
    if snapshot.item_count != item_count
        || snapshot.replacement != if empty { "empty" } else { "value" }
    {
        return Err("A category's replacement metadata does not match its content.".to_string());
    }
    Ok(())
}

fn snapshot_semantics(snapshot: &CategorySnapshot) -> Result<(u32, bool), String> {
    let (count, empty) = match (snapshot.id, &snapshot.data) {
        (SettingsCategoryId::ApiKeys, CategorySnapshotData::Json(Value::Object(value))) => {
            let count = value["apiKeys"]
                .as_object()
                .map_or(0, Map::len)
                .saturating_add(value["webSearchApiKeys"].as_object().map_or(0, Map::len));
            (count, count == 0)
        }
        (SettingsCategoryId::AgentProviderPreferences, CategorySnapshotData::Json(_)) => (6, false),
        (SettingsCategoryId::DesktopAppearance, CategorySnapshotData::Json(_)) => (9, false),
        (SettingsCategoryId::ChatVoicePreferences, CategorySnapshotData::Json(_)) => {
            (CHAT_VOICE_PREFERENCE_ITEM_COUNT as usize, false)
        }
        (SettingsCategoryId::GlobalMemory, CategorySnapshotData::Json(Value::Object(value))) => {
            let count = value["entries"].as_array().map_or(0, Vec::len);
            let enabled = value["globalEnabled"].as_bool().unwrap_or(false);
            (count, count == 0 && !enabled)
        }
        (
            SettingsCategoryId::GlobalContextPacks,
            CategorySnapshotData::Json(Value::Object(value)),
        ) => {
            let count = value["contextPacks"].as_array().map_or(0, Vec::len);
            (count, count == 0)
        }
        (SettingsCategoryId::GlobalMcp, CategorySnapshotData::Json(Value::Object(value))) => {
            let config = value["config"].as_object();
            let servers = config
                .and_then(|config| config.get("servers"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let registries = value["marketplace"]
                .get("registries")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let exists = value["exists"].as_bool().unwrap_or(false);
            (
                servers.saturating_add(registries),
                !exists && registries == 0,
            )
        }
        (SettingsCategoryId::GlobalRalphPreferences, CategorySnapshotData::Json(_)) => {
            (RALPH_PREFERENCE_ITEM_COUNT as usize, false)
        }
        (
            SettingsCategoryId::GlobalPrompts | SettingsCategoryId::GlobalRalphFlows,
            CategorySnapshotData::Files(entries),
        ) => (entries.len(), entries.is_empty()),
        _ => return Err("A category payload has an invalid representation.".to_string()),
    };
    let count = u32::try_from(count)
        .map_err(|_| "A category contains too many settings items.".to_string())?;
    Ok((count, empty))
}

fn required_trimmed_string(value: Option<&Value>, error: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| error.to_string())
}

fn require_exact_keys(value: &Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    if value.len() != keys.len() || !keys.iter().all(|key| value.contains_key(*key)) {
        return Err("A category contains unexpected or missing fields.".to_string());
    }
    Ok(())
}

fn require_only_keys(value: &Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    if value.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err("A category contains an unexpected field.".to_string());
    }
    Ok(())
}

fn validate_string_map(value: Option<&Value>, allowed_keys: &[&str]) -> Result<usize, String> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(|| "A settings map is invalid.".to_string())?;
    if object.len() > MAX_TOTAL_ITEMS
        || object
            .iter()
            .any(|(key, value)| !allowed_keys.contains(&key.as_str()) || !value.is_string())
    {
        return Err("A settings map contains invalid entries.".to_string());
    }
    Ok(object.len())
}

fn validate_agent_provider_value(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Agent and provider preferences are invalid.".to_string())?;
    require_exact_keys(
        root,
        &[
            "webSearchActiveProvider",
            "voiceActiveProvider",
            "speechToTextActiveProvider",
            "agentLimits",
            "reviewModel",
            "internalTaskModel",
            "providerEnrollment",
        ],
    )?;
    for key in [
        "webSearchActiveProvider",
        "voiceActiveProvider",
        "speechToTextActiveProvider",
    ] {
        let _ = required_trimmed_string(root.get(key), "A provider preference is invalid.")?;
    }
    if !root
        .get("webSearchActiveProvider")
        .and_then(Value::as_str)
        .is_some_and(|value| VALID_WEB_SEARCH_PROVIDERS.contains(&value))
        || ["voiceActiveProvider", "speechToTextActiveProvider"]
            .into_iter()
            .any(|key| {
                !root
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| VALID_AUDIO_AI_PROVIDERS.contains(&value))
            })
    {
        return Err("A provider preference is unsupported.".to_string());
    }
    let limits = root
        .get("agentLimits")
        .and_then(Value::as_object)
        .ok_or_else(|| "Agent limits are invalid.".to_string())?;
    require_exact_keys(
        limits,
        &["infinite", "executorTurns", "autopilotExecutorIterations"],
    )?;
    if !limits.get("infinite").is_some_and(Value::is_boolean)
        || !(1..=u64::from(MAX_CONFIGURED_EXECUTOR_TURNS)).contains(
            &limits
                .get("executorTurns")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        )
        || !(1..=u64::from(MAX_CONFIGURED_AUTOPILOT_ITERATIONS)).contains(
            &limits
                .get("autopilotExecutorIterations")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        )
    {
        return Err("Agent limits are outside their supported range.".to_string());
    }
    let review = root
        .get("reviewModel")
        .and_then(Value::as_object)
        .ok_or_else(|| "Review-model preferences are invalid.".to_string())?;
    require_exact_keys(review, &["mode", "provider", "model"])?;
    let mode = review
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let provider = review.get("provider");
    let model = review.get("model");
    if !USER_REVIEW_MODEL_MODES.contains(&mode)
        || !review
            .get("provider")
            .is_some_and(|entry| entry.is_null() || entry.is_string())
        || !review
            .get("model")
            .is_some_and(|entry| entry.is_null() || entry.is_string())
    {
        return Err("Review-model preferences are invalid.".to_string());
    }
    match mode {
        "base" if provider.is_some_and(Value::is_null) && model.is_some_and(Value::is_null) => {}
        "dedicated"
            if provider
                .and_then(Value::as_str)
                .is_some_and(|provider| VALID_MODEL_PROVIDERS.contains(&provider))
                && model.and_then(Value::as_str).is_some_and(|model| {
                    !model.trim().is_empty()
                        && model.len() <= 512
                        && !model.chars().any(char::is_control)
                }) => {}
        _ => return Err("Review-model preferences are internally inconsistent.".to_string()),
    }
    let internal_task = root
        .get("internalTaskModel")
        .and_then(Value::as_object)
        .ok_or_else(|| "Internal-task model preferences are invalid.".to_string())?;
    require_exact_keys(internal_task, &["provider", "model", "reasoning"])?;
    let internal_provider = internal_task.get("provider");
    let internal_model = internal_task.get("model");
    if !internal_task
        .get("reasoning")
        .and_then(Value::as_str)
        .is_some_and(|reasoning| REASONING_MODES.contains(&reasoning))
    {
        return Err("Internal-task reasoning is unsupported.".to_string());
    }
    match (internal_provider, internal_model) {
        (Some(provider), Some(model)) if provider.is_null() && model.is_null() => {}
        (Some(provider), Some(model))
            if provider
                .as_str()
                .is_some_and(|provider| VALID_MODEL_PROVIDERS.contains(&provider))
                && model.as_str().is_some_and(|model| {
                    !model.trim().is_empty()
                        && model.len() <= 512
                        && !model.chars().any(char::is_control)
                }) => {}
        _ => {
            return Err("Internal-task model preferences are internally inconsistent.".to_string())
        }
    }
    validate_provider_enrollment(
        root.get("providerEnrollment")
            .ok_or_else(|| "Provider enrollment preferences are missing.".to_string())?,
    )
}

fn validate_provider_enrollment(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Provider enrollment preferences are invalid.".to_string())?;
    require_exact_keys(
        root,
        &[
            "schemaVersion",
            "enabled",
            "mcp",
            "persistentSync",
            "providers",
        ],
    )?;
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !root.get("enabled").is_some_and(Value::is_boolean)
    {
        return Err("Provider enrollment preferences use an unsupported schema.".to_string());
    }
    let mcp = root
        .get("mcp")
        .and_then(Value::as_object)
        .ok_or_else(|| "Provider MCP enrollment preferences are invalid.".to_string())?;
    require_exact_keys(mcp, &["unmanagedNative", "approvals"])?;
    if !mcp
        .get("unmanagedNative")
        .and_then(Value::as_str)
        .is_some_and(|value| ["adopt", "allow", "fail"].contains(&value))
        || mcp.get("approvals").and_then(Value::as_str) != Some("never")
    {
        return Err("Provider MCP enrollment preferences are invalid.".to_string());
    }
    let sync = root
        .get("persistentSync")
        .and_then(Value::as_object)
        .ok_or_else(|| "Provider sync preferences are invalid.".to_string())?;
    require_exact_keys(
        sync,
        &["enabled", "watch", "debounceMs", "fullRescanIntervalMs"],
    )?;
    for key in ["enabled", "watch"] {
        if !sync.get(key).is_some_and(Value::is_boolean) {
            return Err("Provider sync preferences are invalid.".to_string());
        }
    }
    let ranges = [
        ("debounceMs", 50, 60_000),
        ("fullRescanIntervalMs", 10_000, 86_400_000),
    ];
    for (key, minimum, maximum) in ranges {
        if !(minimum..=maximum).contains(&sync.get(key).and_then(Value::as_u64).unwrap_or(0)) {
            return Err("Provider sync timing preferences are invalid.".to_string());
        }
    }
    let providers = root
        .get("providers")
        .and_then(Value::as_object)
        .ok_or_else(|| "Provider enrollment selections are invalid.".to_string())?;
    require_exact_keys(providers, &["codex-cli", "claude-cli", "copilot-cli"])?;
    if providers.values().any(|entry| {
        !entry.as_object().is_some_and(|entry| {
            require_exact_keys(entry, &["enabled"]).is_ok()
                && entry.get("enabled").is_some_and(Value::is_boolean)
        })
    }) {
        return Err("Provider enrollment selections are invalid.".to_string());
    }
    Ok(())
}

fn validate_desktop_appearance_value(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Desktop and appearance settings are invalid.".to_string())?;
    require_exact_keys(root, &["desktop", "appearance"])?;
    let desktop = root
        .get("desktop")
        .and_then(Value::as_object)
        .ok_or_else(|| "Desktop preferences are invalid.".to_string())?;
    require_exact_keys(
        desktop,
        &[
            "assistantBubbleEnabled",
            "assistantBubbleHideWhenFullscreen",
            "assistantBubbleTemporarilyHideSeconds",
            "aiContextMaxMessages",
            "inactiveSessionArchiveDays",
            "archivedSessionRetentionDays",
            "quickVoiceSilenceSeconds",
            "quickVoiceMaxMessages",
        ],
    )?;
    if !desktop
        .get("assistantBubbleEnabled")
        .is_some_and(Value::is_boolean)
        || !desktop
            .get("assistantBubbleHideWhenFullscreen")
            .is_some_and(Value::is_boolean)
        || !(u64::from(MIN_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS)
            ..=u64::from(MAX_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS))
            .contains(
                &desktop
                    .get("assistantBubbleTemporarilyHideSeconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
        || !(u64::from(MIN_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES)
            ..=u64::from(MAX_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES))
            .contains(
                &desktop
                    .get("aiContextMaxMessages")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
        || !(u64::from(MIN_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS)
            ..=u64::from(MAX_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS))
            .contains(
                &desktop
                    .get("inactiveSessionArchiveDays")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
        || !(u64::from(MIN_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS)
            ..=u64::from(MAX_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS))
            .contains(
                &desktop
                    .get("archivedSessionRetentionDays")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
        || !(MIN_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS
            ..=MAX_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS)
            .contains(
                &desktop
                    .get("quickVoiceSilenceSeconds")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
            )
        || !(u64::from(MIN_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES)
            ..=u64::from(MAX_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES))
            .contains(
                &desktop
                    .get("quickVoiceMaxMessages")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
    {
        return Err("Desktop preferences are outside their supported range.".to_string());
    }
    let appearance = root
        .get("appearance")
        .and_then(Value::as_object)
        .ok_or_else(|| "Appearance preferences are invalid.".to_string())?;
    require_exact_keys(
        appearance,
        &[
            "version",
            "theme",
            "density",
            "accent",
            "quickChatBubbleStyle",
        ],
    )?;
    if appearance.get("version").and_then(Value::as_u64) != Some(1)
        || !appearance
            .get("theme")
            .and_then(Value::as_str)
            .is_some_and(|value| ["dark", "light"].contains(&value))
        || !appearance
            .get("density")
            .and_then(Value::as_str)
            .is_some_and(|value| ["comfortable", "compact"].contains(&value))
        || !appearance
            .get("accent")
            .and_then(Value::as_str)
            .is_some_and(|value| ["sky", "emerald", "violet", "amber"].contains(&value))
        || !appearance
            .get("quickChatBubbleStyle")
            .and_then(Value::as_str)
            .is_some_and(|value| ["classic", "glass", "pulse", "orbit"].contains(&value))
    {
        return Err("Appearance preferences are invalid.".to_string());
    }
    Ok(())
}

fn validate_memory_value(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Global memory settings are invalid.".to_string())?;
    require_exact_keys(root, &["globalEnabled", "entries"])?;
    if !root.get("globalEnabled").is_some_and(Value::is_boolean) {
        return Err("The global-memory enabled state is invalid.".to_string());
    }
    let entries = root
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| "Global memory entries are invalid.".to_string())?;
    if entries.len() > MAX_TOTAL_ITEMS {
        return Err("Global memory contains too many entries.".to_string());
    }
    let mut ids = HashSet::new();
    for entry in entries {
        let entry = entry
            .as_object()
            .ok_or_else(|| "A global memory entry is invalid.".to_string())?;
        require_exact_keys(
            entry,
            &[
                "id",
                "scope",
                "key",
                "kind",
                "content",
                "importance",
                "confidence",
                "createdAt",
                "updatedAt",
            ],
        )?;
        let id =
            required_trimmed_string(entry.get("id"), "A global memory entry is missing its id.")?;
        if id.len() > 256
            || id.chars().any(char::is_control)
            || entry.get("scope").and_then(Value::as_str) != Some("global")
            || required_trimmed_string(entry.get("key"), "A global memory entry has no key.")
                .is_err()
            || !entry
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| {
                    ["preference", "constraint", "decision", "fact", "workaround"].contains(&kind)
                })
            || required_trimmed_string(
                entry.get("content"),
                "A global memory entry has no content.",
            )
            .is_err()
            || !entry
                .get("importance")
                .and_then(Value::as_u64)
                .is_some_and(|importance| (1..=5).contains(&importance))
            || !entry
                .get("confidence")
                .and_then(Value::as_f64)
                .is_some_and(|confidence| (0.0..=1.0).contains(&confidence))
            || entry.get("createdAt").and_then(Value::as_u64).is_none()
            || entry.get("updatedAt").and_then(Value::as_u64).is_none()
            || !ids.insert(id)
        {
            return Err("A global memory entry is invalid or duplicated.".to_string());
        }
    }
    Ok(())
}

fn validate_nullable_enum(value: Option<&Value>, allowed: &[&str]) -> bool {
    value.is_some_and(|value| {
        value.is_null() || value.as_str().is_some_and(|value| allowed.contains(&value))
    })
}

fn validate_runtime_selection(value: &Value) -> Result<(), String> {
    let selection = value
        .as_object()
        .ok_or_else(|| "A runtime preference is invalid.".to_string())?;
    require_exact_keys(selection, &["provider", "model", "reasoning"])?;
    if !selection
        .get("provider")
        .and_then(Value::as_str)
        .is_some_and(|provider| VALID_MODEL_PROVIDERS.contains(&provider))
        || !selection
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(valid_model_id)
        || !validate_nullable_enum(selection.get("reasoning"), &REASONING_MODES)
    {
        return Err("A runtime provider, model, or reasoning preference is invalid.".to_string());
    }
    Ok(())
}

pub(crate) fn validate_chat_voice_preferences_value(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Chat and voice preferences are invalid.".to_string())?;
    require_exact_keys(root, &["voice", "newChat", "runningTaskMessageAction"])?;
    let voice = root
        .get("voice")
        .and_then(Value::as_object)
        .ok_or_else(|| "Spoken-reply preferences are invalid.".to_string())?;
    require_exact_keys(voice, &["autoSpeakResponses", "rate"])?;
    if !voice
        .get("autoSpeakResponses")
        .is_some_and(Value::is_boolean)
        || !voice
            .get("rate")
            .and_then(Value::as_f64)
            .is_some_and(|rate| {
                rate.is_finite() && (MIN_VOICE_RATE..=MAX_VOICE_RATE).contains(&rate)
            })
    {
        return Err("Spoken-reply preferences are outside their supported range.".to_string());
    }

    let new_chat = root
        .get("newChat")
        .and_then(Value::as_object)
        .ok_or_else(|| "New-chat defaults are invalid.".to_string())?;
    require_exact_keys(
        new_chat,
        &[
            "provider",
            "models",
            "mode",
            "reasoning",
            "sessionMemoryEnabled",
            "useGlobalMemory",
            "uiControlEnabled",
        ],
    )?;
    let provider = new_chat
        .get("provider")
        .and_then(Value::as_str)
        .filter(|provider| VALID_MODEL_PROVIDERS.contains(provider))
        .ok_or_else(|| "The new-chat provider is invalid.".to_string())?;
    let models = new_chat
        .get("models")
        .and_then(Value::as_object)
        .ok_or_else(|| "The new-chat model preferences are invalid.".to_string())?;
    if models.is_empty()
        || models.len() > VALID_MODEL_PROVIDERS.len()
        || !models.contains_key(provider)
        || models.iter().any(|(provider, model)| {
            !VALID_MODEL_PROVIDERS.contains(&provider.as_str())
                || !model.as_str().is_some_and(valid_model_id)
        })
        || !validate_nullable_enum(new_chat.get("mode"), &RUN_MODES)
        || !validate_nullable_enum(new_chat.get("reasoning"), &REASONING_MODES)
        || [
            "sessionMemoryEnabled",
            "useGlobalMemory",
            "uiControlEnabled",
        ]
        .into_iter()
        .any(|key| !new_chat.get(key).is_some_and(Value::is_boolean))
        || !root
            .get("runningTaskMessageAction")
            .and_then(Value::as_str)
            .is_some_and(|value| ["steer", "stop-and-send", "queue"].contains(&value))
    {
        return Err("Chat defaults contain an invalid preference.".to_string());
    }
    Ok(())
}

fn valid_context_pack_string(
    value: Option<&Value>,
    maximum_chars: usize,
    allow_empty: bool,
) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        (allow_empty || !value.is_empty())
            && value.trim() == value
            && value.chars().count() <= maximum_chars
            && !value
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    })
}

fn valid_context_pack_number(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|value| value.is_finite() && value >= 0.0)
}

fn validate_context_pack_token_array(value: Option<&Value>) -> Result<(), String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| "A context pack trigger list is invalid.".to_string())?;
    if values.len() > MAX_CONTEXT_PACK_TRIGGERS {
        return Err("A context pack contains too many triggers.".to_string());
    }
    let mut seen = HashSet::new();
    for value in values {
        if !valid_context_pack_string(Some(value), MAX_CONTEXT_PACK_TRIGGER_CHARS, false) {
            return Err("A context pack trigger is invalid.".to_string());
        }
        let token = value.as_str().unwrap_or_default().to_lowercase();
        if !seen.insert(token) {
            return Err("A context pack contains duplicate triggers.".to_string());
        }
    }
    Ok(())
}

fn validate_context_pack_variables(value: Option<&Value>) -> Result<(), String> {
    let variables = value
        .and_then(Value::as_array)
        .ok_or_else(|| "A context pack variable list is invalid.".to_string())?;
    if variables.len() > MAX_CONTEXT_PACK_VARIABLES {
        return Err("A context pack contains too many variables.".to_string());
    }
    let mut seen = HashSet::new();
    for variable in variables {
        let variable = variable
            .as_object()
            .ok_or_else(|| "A context pack variable is invalid.".to_string())?;
        require_only_keys(variable, &["name", "defaultValue"])?;
        let name = variable
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| {
                name.chars().count() <= MAX_CONTEXT_PACK_VARIABLE_CHARS
                    && name
                        .chars()
                        .next()
                        .is_some_and(|character| character.is_ascii_alphabetic())
                    && name.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                    })
            })
            .ok_or_else(|| "A context pack variable name is invalid.".to_string())?;
        if !seen.insert(name.to_lowercase()) {
            return Err("A context pack contains duplicate variables.".to_string());
        }
        if variable.contains_key("defaultValue")
            && !valid_context_pack_string(
                variable.get("defaultValue"),
                MAX_CONTEXT_PACK_TRIGGER_CHARS,
                false,
            )
        {
            return Err("A context pack variable default is invalid.".to_string());
        }
    }
    Ok(())
}

fn validate_context_pack_attachment(value: &Value) -> Result<(), String> {
    let attachment = value
        .as_object()
        .ok_or_else(|| "A context pack attachment is invalid.".to_string())?;
    match attachment.get("source").and_then(Value::as_str) {
        None | Some("path") => {
            require_only_keys(
                attachment,
                &["id", "source", "path", "kind", "name", "parent"],
            )?;
            if !valid_context_pack_string(attachment.get("id"), MAX_CONTEXT_PACK_ID_CHARS, false)
                || !valid_context_pack_string(
                    attachment.get("path"),
                    MAX_CONTEXT_PACK_ATTACHMENT_TEXT_CHARS,
                    false,
                )
                || !valid_context_pack_string(
                    attachment.get("name"),
                    MAX_CONTEXT_PACK_ATTACHMENT_TEXT_CHARS,
                    false,
                )
                || !attachment
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| ["file", "directory", "image", "other"].contains(&kind))
                || attachment.contains_key("parent")
                    && !valid_context_pack_string(
                        attachment.get("parent"),
                        MAX_CONTEXT_PACK_ATTACHMENT_TEXT_CHARS,
                        false,
                    )
            {
                return Err("A context pack path attachment is invalid.".to_string());
            }
        }
        Some("media-asset") => {
            require_only_keys(
                attachment,
                &[
                    "id",
                    "source",
                    "workspaceRoot",
                    "assetId",
                    "kind",
                    "name",
                    "displayName",
                    "rendition",
                ],
            )?;
            for key in ["id", "workspaceRoot", "assetId", "name"] {
                if !valid_context_pack_string(
                    attachment.get(key),
                    MAX_CONTEXT_PACK_ATTACHMENT_TEXT_CHARS,
                    false,
                ) {
                    return Err("A context pack media attachment is invalid.".to_string());
                }
            }
            if !attachment
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| {
                    ["prompt", "image", "alpha-matte", "report", "collection"].contains(&kind)
                })
                || attachment.contains_key("displayName")
                    && !valid_context_pack_string(
                        attachment.get("displayName"),
                        MAX_CONTEXT_PACK_ATTACHMENT_TEXT_CHARS,
                        false,
                    )
                || attachment.contains_key("rendition")
                    && !attachment
                        .get("rendition")
                        .and_then(Value::as_str)
                        .is_some_and(|rendition| {
                            ["thumbnail", "preview", "original"].contains(&rendition)
                        })
            {
                return Err("A context pack media attachment is invalid.".to_string());
            }
        }
        _ => return Err("A context pack attachment source is invalid.".to_string()),
    }
    Ok(())
}

fn validate_context_pack(value: &Value) -> Result<usize, String> {
    let pack = value
        .as_object()
        .ok_or_else(|| "A global context pack is invalid.".to_string())?;
    require_only_keys(
        pack,
        &[
            "id",
            "workspace",
            "name",
            "instructions",
            "prompt",
            "contextAttachments",
            "variables",
            "trigger",
            "provider",
            "model",
            "mode",
            "reasoning",
            "createdAt",
            "updatedAt",
            "lastUsedAt",
            "useCount",
        ],
    )?;
    let _ = context_pack_id(value)?;
    if !pack.get("workspace").is_some_and(Value::is_null)
        || !valid_context_pack_string(pack.get("name"), MAX_CONTEXT_PACK_NAME_CHARS, false)
        || !valid_context_pack_string(pack.get("instructions"), MAX_CONTEXT_PACK_TEXT_CHARS, true)
        || !valid_context_pack_string(pack.get("prompt"), MAX_CONTEXT_PACK_TEXT_CHARS, true)
        || !valid_context_pack_number(pack.get("createdAt"))
        || !valid_context_pack_number(pack.get("updatedAt"))
        || !valid_context_pack_number(pack.get("useCount"))
        || pack.contains_key("lastUsedAt") && !valid_context_pack_number(pack.get("lastUsedAt"))
    {
        return Err("A global context pack has invalid core fields.".to_string());
    }

    let provider = pack.get("provider").and_then(Value::as_str);
    if pack.contains_key("provider")
        && !provider.is_some_and(|provider| VALID_MODEL_PROVIDERS.contains(&provider))
        || pack.contains_key("model")
            && (provider.is_none() || !valid_context_pack_string(pack.get("model"), 512, false))
        || pack.contains_key("mode")
            && !pack
                .get("mode")
                .and_then(Value::as_str)
                .is_some_and(|mode| RUN_MODES.contains(&mode))
        || pack.contains_key("reasoning")
            && !pack
                .get("reasoning")
                .and_then(Value::as_str)
                .is_some_and(|reasoning| REASONING_MODES.contains(&reasoning))
    {
        return Err("A global context pack has invalid model settings.".to_string());
    }

    validate_context_pack_variables(pack.get("variables"))?;
    let trigger = pack
        .get("trigger")
        .and_then(Value::as_object)
        .ok_or_else(|| "A context pack trigger is invalid.".to_string())?;
    require_exact_keys(trigger, &["phrases", "pathPatterns"])?;
    validate_context_pack_token_array(trigger.get("phrases"))?;
    validate_context_pack_token_array(trigger.get("pathPatterns"))?;

    let attachments = pack
        .get("contextAttachments")
        .and_then(Value::as_array)
        .ok_or_else(|| "A context pack attachment list is invalid.".to_string())?;
    if attachments.len() > MAX_TOTAL_ITEMS {
        return Err("A context pack contains too many attachment references.".to_string());
    }
    for attachment in attachments {
        validate_context_pack_attachment(attachment)?;
    }
    Ok(attachments.len())
}

fn validate_global_context_packs_value(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Global context packs are invalid.".to_string())?;
    require_exact_keys(root, &["contextPacks"])?;
    let packs = root
        .get("contextPacks")
        .and_then(Value::as_array)
        .ok_or_else(|| "The global context-pack collection is invalid.".to_string())?;
    if packs.len() > MAX_CONTEXT_PACKS {
        return Err("There are too many global context packs.".to_string());
    }
    let mut ids = HashSet::new();
    let mut attachment_count = 0_usize;
    for pack in packs {
        let id = context_pack_id(pack)?.to_string();
        if !ids.insert(id) {
            return Err("Global context pack ids must be unique.".to_string());
        }
        attachment_count = attachment_count
            .checked_add(validate_context_pack(pack)?)
            .ok_or_else(|| {
                "Global context packs contain too many attachment references.".to_string()
            })?;
        if attachment_count > MAX_TOTAL_ITEMS {
            return Err("Global context packs contain too many attachment references.".to_string());
        }
    }
    Ok(())
}

fn validate_file_entries(
    id: SettingsCategoryId,
    entries: &[FileSnapshotEntry],
) -> Result<(), String> {
    if entries.len() > MAX_TOTAL_ITEMS {
        return Err("A file category contains too many entries.".to_string());
    }
    let mut aliases = HashSet::new();
    let mut flow_ids = HashSet::new();
    for entry in entries {
        validate_wire_path(&entry.relative_path)?;
        let alias = entry.relative_path.nfc().collect::<String>().to_lowercase();
        if !aliases.insert(alias) {
            return Err("A file category contains colliding paths.".to_string());
        }
        if entry.utf8_content.len() as u64
            > if id == SettingsCategoryId::GlobalRalphFlows
                && entry.relative_path.starts_with("flows/")
            {
                MAX_RALPH_FLOW_BYTES
            } else {
                MAX_TEXT_FILE_BYTES
            }
            || sha256_hex(entry.utf8_content.as_bytes()) != entry.sha256
        {
            return Err("A settings file failed its size or completeness check.".to_string());
        }
        match id {
            SettingsCategoryId::GlobalPrompts => {
                if !entry.relative_path.starts_with("prompts/")
                    || !entry.relative_path.ends_with(".prompt.md")
                {
                    return Err("A prompt path is outside the allowed global layout.".to_string());
                }
                validate_frontmatter(&entry.utf8_content)?;
            }
            SettingsCategoryId::GlobalRalphFlows => {
                if let Some(path_flow_id) = global_ralph::flow_id_from_path(&entry.relative_path) {
                    let value = serde_json::from_str::<Value>(&entry.utf8_content)
                        .map_err(|_| "A RALPH flow contains invalid JSON.".to_string())?;
                    let flow_id = global_ralph::validate_flow(&value)?;
                    if path_flow_id != flow_id || !flow_ids.insert(flow_id) {
                        return Err("A RALPH flow path or id is invalid or duplicated.".to_string());
                    }
                } else {
                    return Err(
                        "A RALPH settings path is outside the allowed global layout.".to_string(),
                    );
                }
            }
            _ => return Err("A JSON category cannot contain file entries.".to_string()),
        }
    }
    if has_file_ancestor_collision(aliases.iter().map(String::as_str)) {
        return Err("A file category contains a path nested below another file.".to_string());
    }
    if id == SettingsCategoryId::GlobalRalphFlows {
        global_ralph::validate_flows_with_core(entries)?;
    }
    Ok(())
}

pub(crate) fn validate_envelope_categories(categories: &[CategorySnapshot]) -> Result<(), String> {
    if categories.len() > SettingsCategoryId::ALL.len() {
        return Err("The transfer contains too many categories.".to_string());
    }
    let mut ids = BTreeSet::new();
    let mut total_bytes = 0_u64;
    let mut total_items = 0_usize;
    for category in categories {
        if !ids.insert(category.id) {
            return Err("The transfer contains a duplicate category.".to_string());
        }
        validate_category_snapshot(category)?;
        total_bytes = total_bytes
            .checked_add(category.plaintext_bytes)
            .ok_or_else(|| "The transfer size is invalid.".to_string())?;
        total_items = total_items
            .checked_add(category.item_count as usize)
            .ok_or_else(|| "The transfer item count is invalid.".to_string())?;
    }
    if total_bytes > MAX_TOTAL_PLAINTEXT_BYTES || total_items > MAX_TOTAL_ITEMS {
        return Err("The transfer exceeds its size or item limit.".to_string());
    }
    Ok(())
}

pub(crate) fn appearance_store_key() -> &'static str {
    APPEARANCE_STORAGE_KEY
}

pub(crate) fn marketplace_store_key() -> &'static str {
    MCP_MARKETPLACE_STORAGE_KEY
}

pub(crate) fn running_task_message_action_store_key() -> &'static str {
    RUNNING_TASK_MESSAGE_ACTION_STORAGE_KEY
}

pub(crate) fn ralph_settings_store_key() -> &'static str {
    RALPH_SETTINGS_STORAGE_KEY
}

pub(crate) fn store_file() -> &'static str {
    STORE_FILE
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    #[test]
    fn snapshot_resource_locks_release_after_an_interrupted_operation() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock should follow the Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-settings-snapshot-locks-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("test root should be created");
        let selected = BTreeSet::from([
            SettingsCategoryId::GlobalMemory,
            SettingsCategoryId::GlobalPrompts,
        ]);
        let resources = category_resource_lock_paths(&root, &selected);

        let interrupted = (|| -> Result<(), String> {
            let _locks = acquire_snapshot_locks(&root, &selected)?;
            for resource in &resources {
                let lock_path =
                    PathBuf::from(format!("{}.machdoch.lock", resource.to_string_lossy()));
                assert!(lock_path.is_dir(), "resource lock should be held");
            }
            Err("injected snapshot interruption".to_string())
        })();

        assert_eq!(
            interrupted.expect_err("operation should be interrupted"),
            "injected snapshot interruption"
        );
        for resource in resources {
            let lock_path = PathBuf::from(format!("{}.machdoch.lock", resource.to_string_lossy()));
            assert!(
                !lock_path.exists(),
                "dropping the interrupted snapshot must release every owned lock"
            );
        }
        std::fs::remove_dir_all(root).expect("test root should be removable");
    }

    #[test]
    fn repeated_snapshot_inspections_reuse_one_export_timestamp() {
        let selected = BTreeSet::from([SettingsCategoryId::GlobalMemory]);

        for _ in 0..3 {
            let timestamps = RefCell::new(Vec::new());
            let snapshots = capture_consistent_snapshots(&selected, |id, exported_at| {
                timestamps.borrow_mut().push(exported_at.to_string());
                SnapshotAvailability::Available(
                    create_json_snapshot(
                        id,
                        json!({
                            "exportedAt": exported_at,
                            "items": [],
                        }),
                        0,
                        true,
                    )
                    .expect("the settings snapshot should serialize"),
                )
            })
            .expect("generated export metadata must remain stable during one inspection");

            assert_eq!(snapshots.len(), 1);
            let timestamps = timestamps.into_inner();
            assert_eq!(timestamps.len(), 2);
            assert_eq!(timestamps[0], timestamps[1]);
        }
    }

    #[test]
    fn snapshot_inspection_still_rejects_a_genuine_setting_change() {
        let selected = BTreeSet::from([SettingsCategoryId::GlobalMemory]);
        let captures = Cell::new(0);

        let error = capture_consistent_snapshots(&selected, |id, exported_at| {
            let capture = captures.get();
            captures.set(capture + 1);
            let items = if capture == 0 {
                Vec::new()
            } else {
                vec![json!({
                    "value": "Changed during inspection",
                })]
            };
            let count = items.len() as u32;
            SnapshotAvailability::Available(
                create_json_snapshot(
                    id,
                    json!({
                        "exportedAt": exported_at,
                        "items": items,
                    }),
                    count,
                    count == 0,
                )
                .expect("the settings snapshot should serialize"),
            )
        })
        .expect_err("a real setting change between inspection passes must still fail");

        assert_eq!(captures.get(), 2);
        assert_eq!(error, "SETTINGS_CHANGED_DURING_INSPECTION");
    }

    #[test]
    fn file_categories_reject_a_file_used_as_an_ancestor_directory() {
        let content = "# Prompt\n";
        let entry = |relative_path: &str| FileSnapshotEntry {
            relative_path: relative_path.to_string(),
            sha256: sha256_hex(content.as_bytes()),
            utf8_content: content.to_string(),
        };
        let entries = vec![
            entry("prompts/review.prompt.md"),
            entry("prompts/review.prompt.md/security.prompt.md"),
        ];

        assert!(
            validate_file_entries(SettingsCategoryId::GlobalPrompts, &entries)
                .expect_err("a file cannot also be an ancestor directory")
                .contains("nested below another file")
        );
    }

    #[test]
    fn provider_and_mcp_schemas_reject_unknown_or_mistyped_fields() {
        let provider = json!({
            "webSearchActiveProvider": "none",
            "voiceActiveProvider": "none",
            "speechToTextActiveProvider": "none",
            "agentLimits": {
                "infinite": false,
                "executorTurns": 64,
                "autopilotExecutorIterations": 16
            },
            "reviewModel": { "mode": "base", "provider": null, "model": null },
            "internalTaskModel": { "provider": null, "model": null, "reasoning": "default" },
            "providerEnrollment": {
                "schemaVersion": 1,
                "enabled": true,
                "mcp": {
                    "unmanagedNative": "allow",
                    "approvals": "never"
                },
                "persistentSync": {
                    "enabled": true,
                    "watch": true,
                    "debounceMs": 500,
                    "fullRescanIntervalMs": 600000
                },
                "providers": {
                    "codex-cli": { "enabled": true },
                    "claude-cli": { "enabled": true },
                    "copilot-cli": { "enabled": true }
                }
            }
        });
        assert!(validate_agent_provider_value(&provider).is_ok());
        let mut provider_with_invalid_reasoning = provider.clone();
        provider_with_invalid_reasoning["internalTaskModel"]["reasoning"] = json!("unsupported");
        assert!(validate_agent_provider_value(&provider_with_invalid_reasoning).is_err());
        let mut provider_with_device_field = provider;
        provider_with_device_field["providerEnrollment"]["persistentSync"]["daemonAtLogin"] =
            json!(true);
        assert!(validate_agent_provider_value(&provider_with_device_field).is_err());

        assert!(global_mcp::validate_config(&json!({
            "schemaVersion": 1,
            "defaults": {
                "enabled": true,
                "securityProfile": "balanced",
                "exposure": "hybrid",
                "roots": "workspace",
                "sampling": "disabled",
                "tasks": "optional",
                "elicitation": "disabled"
            },
            "servers": [{
                "id": "local-tools",
                "transport": {
                    "type": "stdio",
                    "command": "node",
                    "args": ["server.js"],
                    "env": { "TOKEN": "secret" }
                },
                "auth": { "type": "none" }
            }]
        }))
        .is_ok());
        assert!(global_mcp::validate_config(&json!({
            "servers": [{
                "id": "local-tools",
                "transport": { "type": "stdio", "command": "node", "workspaceRoot": "poison" }
            }]
        }))
        .is_err());
        assert!(global_mcp::validate_config(&json!({
            "defaults": { "securityProfile": 42 },
            "servers": []
        }))
        .is_err());
    }

    #[test]
    fn portable_preference_schemas_reject_device_workspace_and_history_fields() {
        let chat_voice = json!({
            "voice": { "autoSpeakResponses": true, "rate": 1.25 },
            "newChat": {
                "provider": "anthropic",
                "models": { "anthropic": "claude-test" },
                "mode": "machdoch",
                "reasoning": "high",
                "sessionMemoryEnabled": true,
                "useGlobalMemory": true,
                "uiControlEnabled": false
            },
            "runningTaskMessageAction": "queue"
        });
        assert!(validate_chat_voice_preferences_value(&chat_voice).is_ok());
        let mut with_voice_uri = chat_voice;
        with_voice_uri["voice"]["preferredVoiceURI"] = json!("machine-voice");
        assert!(validate_chat_voice_preferences_value(&with_voice_uri).is_err());

        let ralph = json!({
            "flowLibraryMode": "all",
            "generation": {
                "provider": "openai",
                "model": "gpt-test",
                "reasoning": "medium"
            },
            "run": {
                "provider": "codex-cli",
                "model": "gpt-test",
                "reasoning": null
            },
            "defaultMaxTransitions": 100
        });
        assert!(validate_global_ralph_preferences_value(&ralph).is_ok());
        let mut with_workspace = ralph;
        with_workspace["workspaceRoot"] = json!("C:/poison");
        assert!(validate_global_ralph_preferences_value(&with_workspace).is_err());
    }

    #[test]
    fn global_memory_schema_requires_ranked_keyed_records() {
        let memory = json!({
            "globalEnabled": true,
            "entries": [{
                "id": "summary-style",
                "scope": "global",
                "key": "summary-style",
                "kind": "preference",
                "content": "The user prefers compact summaries",
                "importance": 4,
                "confidence": 0.9,
                "createdAt": 1,
                "updatedAt": 2
            }]
        });

        assert!(validate_memory_value(&memory).is_ok());
        let mut invalid_importance = memory.clone();
        invalid_importance["entries"][0]["importance"] = json!(6);
        assert!(validate_memory_value(&invalid_importance).is_err());
        let mut missing_key = memory;
        missing_key["entries"][0]
            .as_object_mut()
            .expect("memory entry should be an object")
            .remove("key");
        assert!(validate_memory_value(&missing_key).is_err());
    }

    #[test]
    fn context_pack_transfer_replaces_only_global_scope() {
        let pack = |id: &str, workspace: Value| {
            json!({
                "id": id,
                "workspace": workspace,
                "name": format!("Pack {id}"),
                "instructions": "Use the selected context.",
                "prompt": "Review the current task.",
                "contextAttachments": [],
                "variables": [],
                "trigger": { "phrases": [], "pathPatterns": [] },
                "createdAt": 1,
                "updatedAt": 1,
                "useCount": 0
            })
        };
        let shell_state = json!({
            "contextPacks": [
                pack("old-global", Value::Null),
                pack("workspace-pack", json!("C:/workspace"))
            ]
        });
        let incoming = vec![pack("new-global", Value::Null)];

        assert_eq!(
            global_context_packs_from_shell_state(&shell_state)
                .expect("the global projection should be readable")[0]["id"],
            json!("old-global")
        );
        let replaced = replace_global_context_packs(&shell_state, &incoming)
            .expect("global replacement should preserve workspace packs");
        assert_eq!(replaced.len(), 2);
        assert_eq!(replaced[0]["id"], json!("new-global"));
        assert_eq!(replaced[0]["workspace"], Value::Null);
        assert_eq!(replaced[1]["id"], json!("workspace-pack"));
        assert_eq!(replaced[1]["workspace"], json!("C:/workspace"));

        assert!(validate_global_context_packs_value(&json!({
            "contextPacks": [pack("poison", json!("C:/workspace"))]
        }))
        .is_err());
    }

    #[test]
    fn directory_chain_validation_rejects_an_invalid_ancestor() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock should follow the Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-settings-directory-chain-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("test root should be created");
        fs::write(root.join("ralph"), b"not a directory")
            .expect("invalid ancestor fixture should be created");

        assert!(verify_unlinked_directory_chain(&root, &root.join("ralph/flows")).is_err());

        fs::remove_dir_all(&root).expect("test root should be removable");
    }

    #[test]
    fn category_digest_detects_payload_tampering() {
        let mut snapshot = create_json_snapshot(
            SettingsCategoryId::ApiKeys,
            json!({ "apiKeys": {}, "webSearchApiKeys": {} }),
            0,
            true,
        )
        .expect("snapshot should serialize");
        assert!(validate_category_snapshot(&snapshot).is_ok());
        if let CategorySnapshotData::Json(value) = &mut snapshot.data {
            value["apiKeys"]["openai"] = json!("changed");
        }
        assert!(validate_category_snapshot(&snapshot).is_err());
    }

    #[test]
    fn category_metadata_cannot_misrepresent_replace_as_clear_or_hide_items() {
        let mut snapshot = create_json_snapshot(
            SettingsCategoryId::ApiKeys,
            json!({ "apiKeys": { "openai": "secret" }, "webSearchApiKeys": {} }),
            1,
            false,
        )
        .expect("snapshot should serialize");
        assert!(validate_category_snapshot(&snapshot).is_ok());

        snapshot.replacement = "empty".to_string();
        assert!(validate_category_snapshot(&snapshot).is_err());
        snapshot.replacement = "value".to_string();
        snapshot.item_count = 0;
        assert!(validate_category_snapshot(&snapshot).is_err());
    }
}
