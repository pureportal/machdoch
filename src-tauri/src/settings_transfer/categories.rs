use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt as _;
use unicode_normalization::UnicodeNormalization as _;
use zeroize::{Zeroize as _, Zeroizing};

use crate::runtime_contract_generated::{
    DEFAULT_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    DEFAULT_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_ENABLED,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_HIDE_WHEN_FULLSCREEN,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    DEFAULT_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
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
    USER_API_PROVIDERS, USER_REVIEW_MODEL_MODES, USER_WEB_SEARCH_PROVIDERS,
    VALID_AUDIO_AI_PROVIDERS, VALID_MODEL_PROVIDERS, VALID_WEB_SEARCH_PROVIDERS,
};
use crate::{
    cooperative_file_lock::{acquire_cooperative_file_lock, CooperativeFileLock},
    runtime_snapshot::{get_user_config_directory, user_config},
};

use super::contract::{
    CategoryAvailabilityState, CategorySnapshot, CategorySnapshotData, CategoryStatus,
    FileSnapshotEntry, SettingsCategoryId, SnapshotAvailability, CATEGORY_SCHEMA_VERSION,
};

pub(crate) const MAX_TOTAL_PLAINTEXT_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_TOTAL_ITEMS: usize = 2_000;
pub(crate) const MAX_TEXT_FILE_BYTES: u64 = 128 * 1024;
pub(crate) const MAX_USER_CONFIG_BYTES: u64 = 8 * 1024 * 1024;
pub(crate) const MAX_MCP_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const MAX_RALPH_FLOW_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES: usize = 512;
const MAX_RELATIVE_PATH_DEPTH: usize = 12;
const MAX_PATH_COMPONENT_BYTES: usize = 255;
const RALPH_CORE_VALIDATION_TIMEOUT: Duration = Duration::from_secs(60);
const STORE_FILE: &str = "machdoch-shell-state.json";
const APPEARANCE_STORAGE_KEY: &str = "machdoch.desktop.appearance-state";
const MCP_MARKETPLACE_STORAGE_KEY: &str = "machdoch.desktop.mcp-marketplace-state";

fn path_entry_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("A global settings path could not be inspected.".to_string()),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect()
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

fn create_json_snapshot(
    id: SettingsCategoryId,
    value: Value,
    item_count: u32,
    empty: bool,
) -> Result<CategorySnapshot, String> {
    let data = CategorySnapshotData::Json(value);
    let bytes = Zeroizing::new(
        serde_json::to_vec(&data)
            .map_err(|_| "The selected settings could not be serialized.".to_string())?,
    );
    Ok(CategorySnapshot {
        id,
        schema_version: CATEGORY_SCHEMA_VERSION,
        replacement: if empty { "empty" } else { "value" }.to_string(),
        item_count,
        plaintext_bytes: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
        data,
    })
}

fn create_file_snapshot(
    id: SettingsCategoryId,
    entries: Vec<FileSnapshotEntry>,
) -> Result<CategorySnapshot, String> {
    let item_count =
        u32::try_from(entries.len()).map_err(|_| "Too many settings files.".to_string())?;
    let data = CategorySnapshotData::Files(entries);
    let bytes = Zeroizing::new(
        serde_json::to_vec(&data)
            .map_err(|_| "The selected settings could not be serialized.".to_string())?,
    );
    Ok(CategorySnapshot {
        id,
        schema_version: CATEGORY_SCHEMA_VERSION,
        replacement: if item_count == 0 { "empty" } else { "value" }.to_string(),
        item_count,
        plaintext_bytes: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
        data,
    })
}

fn snapshot_api_keys() -> Result<CategorySnapshot, String> {
    let root = load_user_config_value()?;
    let root = root
        .as_object()
        .ok_or_else(|| "Global user settings are invalid.".to_string())?;
    let api_keys = object_or_empty(root.get("apiKeys"));
    let web_search = object_or_empty(root.get("webSearch"));
    let web_search_keys = object_or_empty(web_search.get("apiKeys"));

    for value in api_keys.values().chain(web_search_keys.values()) {
        if !value.is_string() {
            return Err("A persisted API-key entry has an invalid value.".to_string());
        }
    }

    let count = api_keys.len().saturating_add(web_search_keys.len());
    create_json_snapshot(
        SettingsCategoryId::ApiKeys,
        json!({
            "apiKeys": api_keys,
            "webSearchApiKeys": web_search_keys,
        }),
        u32::try_from(count).unwrap_or(u32::MAX),
        count == 0,
    )
}

fn normalized_provider_enrollment(value: Option<&Value>) -> Value {
    let root = object_or_empty(value);
    let instructions = object_or_empty(root.get("instructions"));
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
        "instructions": {
            "mode": "native-when-available",
            "unmanagedNative": instructions.get("unmanagedNative").and_then(Value::as_str).filter(|value| ["adopt", "allow", "fail"].contains(value)).unwrap_or("adopt"),
            "strictConflicts": instructions.get("strictConflicts").and_then(Value::as_bool).unwrap_or(false),
            "fallback": "automatic",
            "failOnTruncation": instructions.get("failOnTruncation").and_then(Value::as_bool).unwrap_or(false),
        },
        "mcp": {
            "mode": "direct-native",
            "fallback": "per-server-stdio-proxy",
            "compatibilityServerName": mcp.get("compatibilityServerName").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).unwrap_or("machdoch-compat"),
            "unmanagedNative": mcp.get("unmanagedNative").and_then(Value::as_str).filter(|value| ["adopt", "allow", "fail"].contains(value)).unwrap_or("allow"),
            "approvals": "never",
            "progressiveDiscoveryThresholdPercent": mcp.get("progressiveDiscoveryThresholdPercent").and_then(Value::as_u64).unwrap_or(3).clamp(1, 5),
        },
        "persistentSync": {
            "enabled": sync.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            "watch": sync.get("watch").and_then(Value::as_bool).unwrap_or(true),
            "debounceMs": sync.get("debounceMs").and_then(Value::as_u64).unwrap_or(500).clamp(50, 60_000),
            "filesystemConvergenceTargetMs": sync.get("filesystemConvergenceTargetMs").and_then(Value::as_u64).unwrap_or(2_000).clamp(100, 60_000),
            "fullRescanIntervalMs": sync.get("fullRescanIntervalMs").and_then(Value::as_u64).unwrap_or(600_000).clamp(10_000, 86_400_000),
            "autoReloadOwnedSessions": sync.get("autoReloadOwnedSessions").and_then(Value::as_bool).unwrap_or(true),
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
        "providerEnrollment": normalized_provider_enrollment(root.get("providerEnrollment")),
    });
    validate_agent_provider_value(&value)?;
    create_json_snapshot(
        SettingsCategoryId::AgentProviderPreferences,
        value,
        6,
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

fn snapshot_global_instructions() -> Result<CategorySnapshot, String> {
    let root = get_user_config_directory()?;
    let mut entries = Vec::new();
    let always = root.join("instructions.md");
    if path_entry_exists(&always)? {
        verify_regular_contained_file(&root, &always, MAX_TEXT_FILE_BYTES)?;
        let content = fs::read_to_string(&always).map_err(|_| {
            "The global instruction file must contain valid UTF-8 text.".to_string()
        })?;
        validate_frontmatter(&content)?;
        entries.push(FileSnapshotEntry {
            relative_path: "instructions.md".to_string(),
            sha256: sha256_hex(content.as_bytes()),
            utf8_content: content,
        });
    }
    entries.extend(collect_tree_files(
        &root,
        &root.join("instructions"),
        "instructions",
        ".instructions.md",
    )?);
    create_file_snapshot(SettingsCategoryId::GlobalInstructions, entries)
}

fn snapshot_global_prompts() -> Result<CategorySnapshot, String> {
    let root = get_user_config_directory()?;
    let entries = collect_tree_files(&root, &root.join("prompts"), "prompts", ".prompt.md")?;
    create_file_snapshot(SettingsCategoryId::GlobalPrompts, entries)
}

fn normalize_marketplace(value: Option<Value>) -> Result<Value, String> {
    let root = value.as_ref().and_then(Value::as_object);
    let entries = root
        .and_then(|value| value.get("registries"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = HashSet::new();
    let mut registries = Vec::new();
    for entry in entries {
        let object = entry
            .as_object()
            .ok_or_else(|| "An MCP marketplace registry is invalid.".to_string())?;
        let id = required_trimmed_string(object.get("id"), "An MCP registry is missing its id.")?;
        let title =
            required_trimmed_string(object.get("title"), "An MCP registry is missing its title.")?;
        let base_url =
            required_trimmed_string(object.get("baseUrl"), "An MCP registry is missing its URL.")?;
        let parsed = reqwest::Url::parse(&base_url)
            .map_err(|_| "An MCP registry URL is invalid.".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("An MCP registry URL must use HTTP or HTTPS.".to_string());
        }
        if !seen.insert(id.to_lowercase()) {
            return Err("MCP registry ids must be unique.".to_string());
        }
        registries.push(json!({
            "id": id,
            "title": title,
            "baseUrl": base_url,
            "enabled": object.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        }));
    }
    Ok(json!({ "version": 1, "registries": registries }))
}

fn snapshot_global_mcp<R: Runtime>(app: &AppHandle<R>) -> Result<CategorySnapshot, String> {
    let root = get_user_config_directory()?;
    let path = root.join("mcp.json");
    let exists = path_entry_exists(&path)?;
    let config = if exists {
        verify_regular_contained_file(&root, &path, MAX_MCP_BYTES)?;
        let raw = Zeroizing::new(fs::read_to_string(&path).map_err(|_| {
            "The global MCP configuration must contain valid UTF-8 text.".to_string()
        })?);
        if raw.len() as u64 > MAX_MCP_BYTES {
            return Err("The global MCP configuration exceeds the transfer limit.".to_string());
        }
        serde_json::from_str::<Value>(&raw)
            .map_err(|_| "The global MCP configuration is invalid JSON.".to_string())?
    } else {
        json!({})
    };
    validate_mcp_config(&config)?;
    let store = app
        .store(STORE_FILE)
        .map_err(|_| "MCP registry settings are unavailable.".to_string())?;
    let marketplace = normalize_marketplace(store.get(MCP_MARKETPLACE_STORAGE_KEY))?;
    let registry_count = marketplace["registries"].as_array().map_or(0, Vec::len);
    let server_count = config
        .get("servers")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let empty = !exists && registry_count == 0;
    create_json_snapshot(
        SettingsCategoryId::GlobalMcp,
        json!({ "exists": exists, "config": config, "marketplace": marketplace }),
        u32::try_from(server_count.saturating_add(registry_count)).unwrap_or(u32::MAX),
        empty,
    )
}

fn is_safe_flow_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

pub(crate) fn ralph_flow_id_from_path(path: &str) -> Option<&str> {
    let flow_id = path.strip_prefix("flows/")?.strip_suffix(".json")?;
    if flow_id.contains('/') || !is_safe_flow_id(flow_id) {
        return None;
    }
    Some(flow_id)
}

pub(crate) fn ralph_instruction_flow_id(path: &str) -> Option<&str> {
    let components = path.split('/').collect::<Vec<_>>();
    let flow_id = *components.get(1)?;
    if components.first().copied() != Some("instructions") || !is_safe_flow_id(flow_id) {
        return None;
    }
    if components.len() == 3 && components[2] == "instructions.md" {
        return Some(flow_id);
    }
    let file_name = components.last().copied()?;
    if components.len() >= 4
        && components[2] == "instructions"
        && file_name != ".instructions.md"
        && file_name.ends_with(".instructions.md")
    {
        return Some(flow_id);
    }
    None
}

fn validate_ralph_flow(value: &Value) -> Result<String, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "A RALPH flow must be a JSON object.".to_string())?;
    if root.contains_key("workspaceRoot") || root.contains_key("path") || root.contains_key("scope")
    {
        return Err("A global RALPH flow contains a forbidden scope field.".to_string());
    }
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("A RALPH flow must explicitly use schema version 1.".to_string());
    }
    let id = required_trimmed_string(root.get("id"), "A RALPH flow is missing its id.")?;
    if !is_safe_flow_id(&id) {
        return Err("A RALPH flow has an invalid id.".to_string());
    }
    let _ = required_trimmed_string(root.get("name"), "A RALPH flow is missing its name.")?;
    let blocks = root
        .get("blocks")
        .and_then(Value::as_array)
        .ok_or_else(|| "A RALPH flow must contain a block list.".to_string())?;
    let edges = root
        .get("edges")
        .and_then(Value::as_array)
        .ok_or_else(|| "A RALPH flow must contain an edge list.".to_string())?;
    if blocks.is_empty() || blocks.len() > 250 || edges.len() > 500 {
        return Err("A RALPH flow has an invalid number of blocks or edges.".to_string());
    }
    let mut block_ids = HashSet::new();
    for block in blocks {
        let block = block
            .as_object()
            .ok_or_else(|| "A RALPH flow block is invalid.".to_string())?;
        let block_id =
            required_trimmed_string(block.get("id"), "A RALPH flow block is missing its id.")?;
        let _ =
            required_trimmed_string(block.get("type"), "A RALPH flow block is missing its type.")?;
        if !block_ids.insert(block_id) {
            return Err("A RALPH flow contains duplicate block ids.".to_string());
        }
        if let Some(workspace) = block
            .get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("workspace"))
            .and_then(Value::as_object)
        {
            if workspace.get("mode").and_then(Value::as_str) == Some("custom")
                || workspace.get("path").and_then(Value::as_str).is_some()
            {
                return Err("A global RALPH flow declares workspace-specific settings.".to_string());
            }
        }
    }
    for edge in edges {
        let edge = edge
            .as_object()
            .ok_or_else(|| "A RALPH flow edge is invalid.".to_string())?;
        let from =
            required_trimmed_string(edge.get("from"), "A RALPH edge is missing its source.")?;
        let to = required_trimmed_string(edge.get("to"), "A RALPH edge is missing its target.")?;
        if !block_ids.contains(&from) || !block_ids.contains(&to) {
            return Err("A RALPH edge references a missing block.".to_string());
        }
    }
    Ok(id)
}

fn validate_ralph_flows_with_core(entries: &[FileSnapshotEntry]) -> Result<(), String> {
    let flows = entries
        .iter()
        .filter(|entry| ralph_flow_id_from_path(&entry.relative_path).is_some())
        .collect::<Vec<_>>();
    if flows.is_empty() {
        return Ok(());
    }

    let estimated_bytes = flows.iter().try_fold(
        64_usize
            .checked_add(flows.len())
            .ok_or_else(|| "The RALPH validation batch exceeds its transfer bound.".to_string())?,
        |total, entry| {
            total
                .checked_add(entry.utf8_content.len())
                .ok_or_else(|| "The RALPH validation batch exceeds its transfer bound.".to_string())
        },
    )?;
    if estimated_bytes as u64 > MAX_TOTAL_PLAINTEXT_BYTES.saturating_add(64 * 1024) {
        return Err("The RALPH validation batch exceeds its transfer bound.".to_string());
    }
    let mut batch = Zeroizing::new(Vec::with_capacity(estimated_bytes));
    batch.extend_from_slice(b"{\"schemaVersion\":1,\"flows\":[");
    for (index, entry) in flows.iter().enumerate() {
        if index > 0 {
            batch.push(b',');
        }
        batch.extend_from_slice(entry.utf8_content.as_bytes());
    }
    batch.extend_from_slice(b"]}");

    let arguments = vec![
        "--json".to_string(),
        "ralph".to_string(),
        "validate-json".to_string(),
        "--flow-json-file".to_string(),
        "-".to_string(),
    ];
    let response = crate::shared_cli::run_side_effect_free_json_command(
        &arguments,
        batch,
        RALPH_CORE_VALIDATION_TIMEOUT,
    )
    .map_err(|_| "The complete RALPH flow validator could not run safely.".to_string())?;
    let results = response
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "The complete RALPH flow validator returned an invalid result.".to_string()
        })?;
    if response.get("valid").and_then(Value::as_bool) != Some(true) || results.len() != flows.len()
    {
        return Err("A RALPH flow failed complete parser or graph validation.".to_string());
    }
    for (entry, result) in flows.iter().zip(results) {
        let expected_id = ralph_flow_id_from_path(&entry.relative_path).unwrap_or_default();
        if result.get("valid").and_then(Value::as_bool) != Some(true)
            || result.get("id").and_then(Value::as_str) != Some(expected_id)
        {
            return Err("A RALPH flow failed complete parser or graph validation.".to_string());
        }
    }
    Ok(())
}

fn snapshot_global_ralph() -> Result<CategorySnapshot, String> {
    let global_root = get_user_config_directory()?;
    let ralph_root = global_root.join("ralph");
    let flow_root = ralph_root.join("flows");
    let mut entries = Vec::new();
    let mut flow_ids = BTreeSet::new();
    if verify_unlinked_directory_chain(&global_root, &flow_root)? {
        for entry in fs::read_dir(&flow_root)
            .map_err(|_| "The global RALPH flow directory could not be read.".to_string())?
        {
            let entry =
                entry.map_err(|_| "A global RALPH flow entry could not be read.".to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| "A global RALPH flow entry could not be inspected.".to_string())?;
            if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
                return Err("The global RALPH flow directory contains a linked entry.".to_string());
            }
            if metadata.is_dir() {
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            verify_regular_contained_file(&global_root, &path, MAX_RALPH_FLOW_BYTES)?;
            let content = fs::read_to_string(&path)
                .map_err(|_| "A global RALPH flow must contain valid UTF-8 JSON.".to_string())?;
            let value = serde_json::from_str::<Value>(&content)
                .map_err(|_| "A global RALPH flow contains invalid JSON.".to_string())?;
            let id = validate_ralph_flow(&value)?;
            if !flow_ids.insert(id.clone()) {
                return Err("Global RALPH flow ids must be unique.".to_string());
            }
            let expected_file = format!("{id}.json");
            if entry.file_name().to_string_lossy().to_lowercase() != expected_file.to_lowercase() {
                return Err("A global RALPH flow filename does not match its id.".to_string());
            }
            entries.push(FileSnapshotEntry {
                relative_path: format!("flows/{expected_file}"),
                sha256: sha256_hex(content.as_bytes()),
                utf8_content: content,
            });
        }
    }
    for flow_id in &flow_ids {
        let instruction_root = ralph_root.join("instructions").join(flow_id);
        if !verify_unlinked_directory_chain(&global_root, &instruction_root)? {
            continue;
        }
        let always = instruction_root.join("instructions.md");
        if path_entry_exists(&always)? {
            verify_regular_contained_file(&global_root, &always, MAX_TEXT_FILE_BYTES)?;
            let content = fs::read_to_string(&always).map_err(|_| {
                "A RALPH instruction file must contain valid UTF-8 text.".to_string()
            })?;
            validate_frontmatter(&content)?;
            entries.push(FileSnapshotEntry {
                relative_path: format!("instructions/{flow_id}/instructions.md"),
                sha256: sha256_hex(content.as_bytes()),
                utf8_content: content,
            });
        }
        entries.extend(collect_tree_files(
            &global_root,
            &instruction_root.join("instructions"),
            &format!("instructions/{flow_id}/instructions"),
            ".instructions.md",
        )?);
    }
    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    create_file_snapshot(SettingsCategoryId::GlobalRalphFlows, entries)
}

pub(crate) fn snapshot_category<R: Runtime>(
    app: &AppHandle<R>,
    id: SettingsCategoryId,
) -> SnapshotAvailability {
    let result = match id {
        SettingsCategoryId::ApiKeys => snapshot_api_keys(),
        SettingsCategoryId::AgentProviderPreferences => snapshot_agent_provider_preferences(),
        SettingsCategoryId::DesktopAppearance => snapshot_desktop_appearance(app),
        SettingsCategoryId::GlobalMemory => snapshot_global_memory(),
        SettingsCategoryId::GlobalInstructions => snapshot_global_instructions(),
        SettingsCategoryId::GlobalPrompts => snapshot_global_prompts(),
        SettingsCategoryId::GlobalMcp => snapshot_global_mcp(app),
        SettingsCategoryId::GlobalRalphFlows => snapshot_global_ralph(),
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
    if categories.contains(&SettingsCategoryId::GlobalInstructions) {
        paths.push(root.join("instructions.transfer-boundary"));
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
                SettingsCategoryId::AgentProviderPreferences
                    | SettingsCategoryId::GlobalInstructions
                    | SettingsCategoryId::GlobalMcp
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

pub(crate) fn snapshot_selected<R: Runtime>(
    app: &AppHandle<R>,
    selected: &BTreeSet<SettingsCategoryId>,
) -> Result<BTreeMap<SettingsCategoryId, SnapshotAvailability>, String> {
    let root = get_user_config_directory()?;
    let _ = verify_unlinked_directory_chain(&root, &root)?;
    let _locks = acquire_snapshot_locks(&root, selected)?;
    let capture = || {
        selected
            .iter()
            .copied()
            .map(|id| (id, snapshot_category(app, id)))
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
            validate_api_keys_value(value)
        }
        (SettingsCategoryId::AgentProviderPreferences, CategorySnapshotData::Json(value)) => {
            validate_agent_provider_value(value)
        }
        (SettingsCategoryId::DesktopAppearance, CategorySnapshotData::Json(value)) => {
            validate_desktop_appearance_value(value)
        }
        (SettingsCategoryId::GlobalMemory, CategorySnapshotData::Json(value)) => {
            validate_memory_value(value)
        }
        (SettingsCategoryId::GlobalMcp, CategorySnapshotData::Json(value)) => {
            validate_mcp_value(value)
        }
        (SettingsCategoryId::GlobalInstructions, CategorySnapshotData::Files(entries)) => {
            validate_file_entries(snapshot.id, entries)
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
        (SettingsCategoryId::GlobalMemory, CategorySnapshotData::Json(Value::Object(value))) => {
            let count = value["entries"].as_array().map_or(0, Vec::len);
            let enabled = value["globalEnabled"].as_bool().unwrap_or(false);
            (count, count == 0 && !enabled)
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
        (
            SettingsCategoryId::GlobalInstructions
            | SettingsCategoryId::GlobalPrompts
            | SettingsCategoryId::GlobalRalphFlows,
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

fn validate_api_keys_value(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "The API-key category is invalid.".to_string())?;
    require_exact_keys(root, &["apiKeys", "webSearchApiKeys"])?;
    let count = validate_string_map(root.get("apiKeys"), &USER_API_PROVIDERS)?.saturating_add(
        validate_string_map(root.get("webSearchApiKeys"), &USER_WEB_SEARCH_PROVIDERS)?,
    );
    if count > MAX_TOTAL_ITEMS {
        return Err("The API-key category contains too many entries.".to_string());
    }
    Ok(())
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
            "instructions",
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
    let instructions = root
        .get("instructions")
        .and_then(Value::as_object)
        .ok_or_else(|| "Provider instruction enrollment preferences are invalid.".to_string())?;
    require_exact_keys(
        instructions,
        &[
            "mode",
            "unmanagedNative",
            "strictConflicts",
            "fallback",
            "failOnTruncation",
        ],
    )?;
    if instructions.get("mode").and_then(Value::as_str) != Some("native-when-available")
        || !instructions
            .get("unmanagedNative")
            .and_then(Value::as_str)
            .is_some_and(|value| ["adopt", "allow", "fail"].contains(&value))
        || !instructions
            .get("strictConflicts")
            .is_some_and(Value::is_boolean)
        || instructions.get("fallback").and_then(Value::as_str) != Some("automatic")
        || !instructions
            .get("failOnTruncation")
            .is_some_and(Value::is_boolean)
    {
        return Err("Provider instruction enrollment preferences are invalid.".to_string());
    }
    let mcp = root
        .get("mcp")
        .and_then(Value::as_object)
        .ok_or_else(|| "Provider MCP enrollment preferences are invalid.".to_string())?;
    require_exact_keys(
        mcp,
        &[
            "mode",
            "fallback",
            "compatibilityServerName",
            "unmanagedNative",
            "approvals",
            "progressiveDiscoveryThresholdPercent",
        ],
    )?;
    if mcp.get("mode").and_then(Value::as_str) != Some("direct-native")
        || mcp.get("fallback").and_then(Value::as_str) != Some("per-server-stdio-proxy")
        || !mcp
            .get("compatibilityServerName")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                !value.trim().is_empty()
                    && value.len() <= 128
                    && !value.chars().any(char::is_control)
            })
        || !mcp
            .get("unmanagedNative")
            .and_then(Value::as_str)
            .is_some_and(|value| ["adopt", "allow", "fail"].contains(&value))
        || mcp.get("approvals").and_then(Value::as_str) != Some("never")
        || !(1..=5).contains(
            &mcp.get("progressiveDiscoveryThresholdPercent")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        )
    {
        return Err("Provider MCP enrollment preferences are invalid.".to_string());
    }
    let sync = root
        .get("persistentSync")
        .and_then(Value::as_object)
        .ok_or_else(|| "Provider sync preferences are invalid.".to_string())?;
    require_exact_keys(
        sync,
        &[
            "enabled",
            "watch",
            "debounceMs",
            "filesystemConvergenceTargetMs",
            "fullRescanIntervalMs",
            "autoReloadOwnedSessions",
        ],
    )?;
    for key in ["enabled", "watch", "autoReloadOwnedSessions"] {
        if !sync.get(key).is_some_and(Value::is_boolean) {
            return Err("Provider sync preferences are invalid.".to_string());
        }
    }
    let ranges = [
        ("debounceMs", 50, 60_000),
        ("filesystemConvergenceTargetMs", 100, 60_000),
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
        require_exact_keys(entry, &["id", "scope", "content", "createdAt", "updatedAt"])?;
        let id =
            required_trimmed_string(entry.get("id"), "A global memory entry is missing its id.")?;
        if id.len() > 256
            || id.chars().any(char::is_control)
            || entry.get("scope").and_then(Value::as_str) != Some("global")
            || required_trimmed_string(
                entry.get("content"),
                "A global memory entry has no content.",
            )
            .is_err()
            || entry.get("createdAt").and_then(Value::as_u64).is_none()
            || entry.get("updatedAt").and_then(Value::as_u64).is_none()
            || !ids.insert(id)
        {
            return Err("A global memory entry is invalid or duplicated.".to_string());
        }
    }
    Ok(())
}

fn validate_mcp_string_array(value: &Value) -> bool {
    value.as_array().is_some_and(|values| {
        values.len() <= MAX_TOTAL_ITEMS
            && values.iter().all(|value| {
                value.as_str().is_some_and(|value| {
                    !value.trim().is_empty()
                        && value.len() <= 4_096
                        && !value.chars().any(char::is_control)
                })
            })
    })
}

fn validate_mcp_string_map(value: &Value) -> bool {
    value.as_object().is_some_and(|values| {
        values.len() <= MAX_TOTAL_ITEMS
            && values.iter().all(|(key, value)| {
                !key.trim().is_empty()
                    && key.len() <= 512
                    && !key.chars().any(char::is_control)
                    && value.is_string()
            })
    })
}

fn valid_mcp_positive_integer(value: Option<&Value>) -> bool {
    value.and_then(Value::as_u64).is_some_and(|value| value > 0)
}

fn valid_optional_mcp_enum(value: Option<&Value>, allowed: &[&str]) -> bool {
    value.is_none_or(|value| value.as_str().is_some_and(|value| allowed.contains(&value)))
}

fn validate_mcp_cache(value: &Value) -> Result<(), String> {
    let cache = value
        .as_object()
        .ok_or_else(|| "An MCP cache policy is invalid.".to_string())?;
    require_only_keys(cache, &["enabled", "ttlMs", "ttlSeconds", "forceRefresh"])?;
    if cache
        .get("enabled")
        .is_some_and(|value| !value.is_boolean())
        || cache
            .get("forceRefresh")
            .is_some_and(|value| !value.is_boolean())
        || cache
            .get("ttlMs")
            .is_some_and(|value| value.as_u64().is_none())
        || cache
            .get("ttlSeconds")
            .is_some_and(|value| value.as_u64().is_none())
    {
        return Err("An MCP cache policy is invalid.".to_string());
    }
    Ok(())
}

fn validate_mcp_roots(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| ["disabled", "workspace"].contains(&value))
        || validate_mcp_string_array(value)
}

fn validate_mcp_defaults(value: &Value) -> Result<(), String> {
    let defaults = value
        .as_object()
        .ok_or_else(|| "The global MCP defaults are invalid.".to_string())?;
    require_only_keys(
        defaults,
        &[
            "enabled",
            "securityProfile",
            "exposure",
            "directTools",
            "timeoutMs",
            "maxTotalTimeoutMs",
            "idleShutdownMs",
            "maxResponseChars",
            "cache",
            "roots",
            "sampling",
            "tasks",
            "elicitation",
        ],
    )?;
    if defaults
        .get("enabled")
        .is_some_and(|value| !value.is_boolean())
        || defaults
            .get("directTools")
            .is_some_and(|value| !value.is_boolean())
        || !valid_optional_mcp_enum(
            defaults.get("securityProfile"),
            &["weak", "balanced", "strict"],
        )
        || !valid_optional_mcp_enum(
            defaults.get("exposure"),
            &["meta-tools", "direct-tools", "hybrid"],
        )
        || ["timeoutMs", "maxTotalTimeoutMs", "maxResponseChars"]
            .into_iter()
            .any(|key| {
                defaults
                    .get(key)
                    .is_some_and(|_| !valid_mcp_positive_integer(defaults.get(key)))
            })
        || defaults
            .get("idleShutdownMs")
            .is_some_and(|value| value.as_u64().is_none())
        || defaults
            .get("roots")
            .is_some_and(|value| !validate_mcp_roots(value))
        || !valid_optional_mcp_enum(defaults.get("sampling"), &["disabled", "ask-agent"])
        || !valid_optional_mcp_enum(defaults.get("tasks"), &["disabled", "optional"])
        || !valid_optional_mcp_enum(defaults.get("elicitation"), &["disabled"])
    {
        return Err("The global MCP defaults are invalid.".to_string());
    }
    if let Some(cache) = defaults.get("cache") {
        validate_mcp_cache(cache)?;
    }
    Ok(())
}

fn validate_mcp_transport(value: &Value) -> Result<(), String> {
    let transport = value
        .as_object()
        .ok_or_else(|| "An MCP transport is invalid.".to_string())?;
    match transport.get("type").and_then(Value::as_str) {
        Some("stdio") => {
            require_only_keys(
                transport,
                &[
                    "type",
                    "command",
                    "args",
                    "cwd",
                    "env",
                    "inheritEnvironment",
                    "stderr",
                ],
            )?;
            let _ = required_trimmed_string(
                transport.get("command"),
                "An MCP stdio transport is missing its command.",
            )?;
            if transport
                .get("args")
                .is_some_and(|value| !validate_mcp_string_array(value))
                || transport.get("cwd").is_some_and(|value| !value.is_string())
                || transport
                    .get("env")
                    .is_some_and(|value| !validate_mcp_string_map(value))
                || transport
                    .get("inheritEnvironment")
                    .is_some_and(|value| !value.is_boolean())
                || !valid_optional_mcp_enum(transport.get("stderr"), &["pipe", "ignore", "inherit"])
            {
                return Err("An MCP stdio transport is invalid.".to_string());
            }
        }
        Some("streamable-http" | "sse") => {
            let is_streamable =
                transport.get("type").and_then(Value::as_str) == Some("streamable-http");
            let allowed = if is_streamable {
                &["type", "url", "headers", "sessionId", "legacySseFallback"][..]
            } else {
                &["type", "url", "headers"][..]
            };
            require_only_keys(transport, allowed)?;
            let url = required_trimmed_string(
                transport.get("url"),
                "An MCP network transport is missing its URL.",
            )?;
            let parsed = reqwest::Url::parse(&url)
                .map_err(|_| "An MCP transport URL is invalid.".to_string())?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || transport
                    .get("headers")
                    .is_some_and(|value| !validate_mcp_string_map(value))
                || transport
                    .get("sessionId")
                    .is_some_and(|value| !value.is_string())
                || transport
                    .get("legacySseFallback")
                    .is_some_and(|value| !value.is_boolean())
            {
                return Err("An MCP network transport is invalid.".to_string());
            }
        }
        _ => return Err("An MCP server uses an unsupported transport.".to_string()),
    }
    Ok(())
}

fn validate_mcp_auth(value: &Value) -> Result<(), String> {
    let auth = value
        .as_object()
        .ok_or_else(|| "An MCP authentication configuration is invalid.".to_string())?;
    let auth_type = auth.get("type").and_then(Value::as_str);
    let allowed = match auth_type {
        Some("none") => &["type"][..],
        Some("bearer") => &["type", "token", "tokenEnv", "headerName"][..],
        Some("headers") => &["type", "headers", "envHeaders"][..],
        Some("oauth") => &[
            "type",
            "clientId",
            "clientSecret",
            "clientSecretEnv",
            "redirectUrl",
            "clientMetadataUrl",
            "scopes",
            "accessToken",
            "accessTokenEnv",
            "refreshToken",
            "refreshTokenEnv",
            "tokenType",
            "tokenScope",
            "expiresIn",
            "idToken",
            "authorizationUrl",
            "authorizationState",
            "codeVerifier",
            "clientInformation",
            "discoveryState",
        ][..],
        _ => return Err("An MCP authentication type is unsupported.".to_string()),
    };
    require_only_keys(auth, allowed)?;
    if auth_type == Some("headers")
        && ["headers", "envHeaders"].into_iter().any(|key| {
            auth.get(key)
                .is_some_and(|value| !validate_mcp_string_map(value))
        })
    {
        return Err("MCP authentication headers are invalid.".to_string());
    }
    if auth_type == Some("oauth")
        && (auth
            .get("scopes")
            .is_some_and(|value| !validate_mcp_string_array(value))
            || auth
                .get("expiresIn")
                .is_some_and(|value| value.as_u64().is_none())
            || ["clientInformation", "discoveryState"]
                .into_iter()
                .any(|key| auth.get(key).is_some_and(|value| !value.is_object())))
    {
        return Err("An MCP OAuth configuration is invalid.".to_string());
    }
    if auth.iter().any(|(key, value)| {
        key != "type"
            && !matches!(
                key.as_str(),
                "headers"
                    | "envHeaders"
                    | "scopes"
                    | "expiresIn"
                    | "clientInformation"
                    | "discoveryState"
            )
            && !value.is_string()
    }) {
        return Err("An MCP authentication value is invalid.".to_string());
    }
    Ok(())
}

fn validate_mcp_exposure(value: &Value) -> Result<(), String> {
    let exposure = value
        .as_object()
        .ok_or_else(|| "An MCP exposure configuration is invalid.".to_string())?;
    require_only_keys(exposure, &["mode", "directTools"])?;
    if !valid_optional_mcp_enum(
        exposure.get("mode"),
        &["meta-tools", "direct-tools", "hybrid"],
    ) {
        return Err("An MCP exposure mode is invalid.".to_string());
    }
    if let Some(direct) = exposure.get("directTools") {
        if direct.is_boolean() {
            return Ok(());
        }
        let direct = direct
            .as_object()
            .ok_or_else(|| "An MCP direct-tool exposure rule is invalid.".to_string())?;
        require_only_keys(
            direct,
            &["enabled", "include", "exclude", "namespacePrefix"],
        )?;
        if direct
            .get("enabled")
            .is_some_and(|value| !value.is_boolean())
            || ["include", "exclude"].into_iter().any(|key| {
                direct
                    .get(key)
                    .is_some_and(|value| !validate_mcp_string_array(value))
            })
            || direct
                .get("namespacePrefix")
                .is_some_and(|value| !value.is_string())
        {
            return Err("An MCP direct-tool exposure rule is invalid.".to_string());
        }
    }
    Ok(())
}

fn validate_mcp_tool_overrides(value: &Value) -> Result<(), String> {
    let overrides = value
        .as_object()
        .ok_or_else(|| "MCP tool overrides are invalid.".to_string())?;
    if overrides.len() > MAX_TOTAL_ITEMS {
        return Err("MCP tool overrides contain too many entries.".to_string());
    }
    for (name, value) in overrides {
        if name.trim().is_empty() || name.len() > 512 {
            return Err("An MCP tool override name is invalid.".to_string());
        }
        let value = value
            .as_object()
            .ok_or_else(|| "An MCP tool override is invalid.".to_string())?;
        require_only_keys(
            value,
            &[
                "enabled",
                "title",
                "description",
                "riskLevel",
                "effect",
                "readOnlyInAskMode",
            ],
        )?;
        if ["enabled", "readOnlyInAskMode"]
            .into_iter()
            .any(|key| value.get(key).is_some_and(|value| !value.is_boolean()))
            || ["title", "description"]
                .into_iter()
                .any(|key| value.get(key).is_some_and(|value| !value.is_string()))
            || !valid_optional_mcp_enum(value.get("riskLevel"), &["low", "medium", "high"])
            || !valid_optional_mcp_enum(
                value.get("effect"),
                &["read", "write", "external-read", "external-side-effect"],
            )
        {
            return Err("An MCP tool override is invalid.".to_string());
        }
    }
    Ok(())
}

fn validate_mcp_server(server: &Value, ids: &mut HashSet<String>) -> Result<(), String> {
    let server = server
        .as_object()
        .ok_or_else(|| "An MCP server entry is invalid.".to_string())?;
    require_only_keys(
        server,
        &[
            "id",
            "title",
            "description",
            "enabled",
            "preset",
            "transport",
            "auth",
            "exposure",
            "securityProfile",
            "timeoutMs",
            "maxTotalTimeoutMs",
            "idleShutdownMs",
            "maxResponseChars",
            "cache",
            "toolOverrides",
            "roots",
            "sampling",
            "tasks",
            "notes",
        ],
    )?;
    let id = required_trimmed_string(server.get("id"), "An MCP server is missing its id.")?;
    if id.len() > 80
        || !id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
        || !ids.insert(id)
    {
        return Err("MCP server ids must be canonical and unique.".to_string());
    }
    if ["title", "description", "preset", "notes"]
        .into_iter()
        .any(|key| server.get(key).is_some_and(|value| !value.is_string()))
        || server
            .get("enabled")
            .is_some_and(|value| !value.is_boolean())
        || !valid_optional_mcp_enum(
            server.get("securityProfile"),
            &["weak", "balanced", "strict"],
        )
        || ["timeoutMs", "maxTotalTimeoutMs", "maxResponseChars"]
            .into_iter()
            .any(|key| {
                server
                    .get(key)
                    .is_some_and(|_| !valid_mcp_positive_integer(server.get(key)))
            })
        || server
            .get("idleShutdownMs")
            .is_some_and(|value| value.as_u64().is_none())
        || server
            .get("roots")
            .is_some_and(|value| !validate_mcp_roots(value))
        || !valid_optional_mcp_enum(server.get("sampling"), &["disabled", "ask-agent"])
        || !valid_optional_mcp_enum(server.get("tasks"), &["disabled", "optional"])
    {
        return Err("An MCP server entry contains invalid settings.".to_string());
    }
    if let Some(value) = server.get("transport") {
        validate_mcp_transport(value)?;
    }
    if let Some(value) = server.get("auth") {
        validate_mcp_auth(value)?;
    }
    if let Some(value) = server.get("exposure") {
        validate_mcp_exposure(value)?;
    }
    if let Some(value) = server.get("cache") {
        validate_mcp_cache(value)?;
    }
    if let Some(value) = server.get("toolOverrides") {
        validate_mcp_tool_overrides(value)?;
    }
    Ok(())
}

fn validate_mcp_config(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "The global MCP configuration must be an object.".to_string())?;
    require_only_keys(root, &["schemaVersion", "defaults", "servers"])?;
    if root
        .get("schemaVersion")
        .is_some_and(|version| version.as_u64() != Some(1))
    {
        return Err("The global MCP configuration uses an unsupported schema.".to_string());
    }
    if let Some(defaults) = root.get("defaults") {
        validate_mcp_defaults(defaults)?;
    }
    let servers = match root.get("servers") {
        None => return Ok(()),
        Some(Value::Array(servers)) => servers,
        _ => return Err("The global MCP server list is invalid.".to_string()),
    };
    if servers.len() > MAX_TOTAL_ITEMS {
        return Err("The global MCP configuration contains too many servers.".to_string());
    }
    let mut ids = HashSet::new();
    for server in servers {
        validate_mcp_server(server, &mut ids)?;
    }
    Ok(())
}

fn validate_mcp_value(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "The MCP category is invalid.".to_string())?;
    require_exact_keys(root, &["exists", "config", "marketplace"])?;
    if !root.get("exists").is_some_and(Value::is_boolean) {
        return Err("The MCP file-presence marker is invalid.".to_string());
    }
    validate_mcp_config(
        root.get("config")
            .ok_or_else(|| "The MCP configuration is missing.".to_string())?,
    )?;
    let normalized = normalize_marketplace(root.get("marketplace").cloned())?;
    if normalized != root["marketplace"] {
        return Err("MCP marketplace registries are not normalized.".to_string());
    }
    Ok(())
}

pub(crate) fn relative_path_to_wire(relative: &Path) -> Result<String, String> {
    let mut components = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => components.push(
                value
                    .to_str()
                    .ok_or_else(|| "A settings path is not valid UTF-8.".to_string())?,
            ),
            _ => return Err("A settings path is not relative.".to_string()),
        }
    }
    Ok(components.join("/"))
}

fn is_windows_reserved_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end_matches([' ', '.'])
        .to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}

fn contains_windows_forbidden_character(component: &str) -> bool {
    component.chars().any(|character| {
        character <= '\u{1f}' || matches!(character, '<' | '>' | '"' | '|' | '?' | '*')
    })
}

pub(crate) fn validate_wire_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > MAX_RELATIVE_PATH_BYTES
        || path.contains('\0')
        || path.contains('\\')
        || path.starts_with('/')
        || path.nfc().collect::<String>() != path
    {
        return Err("A settings entry has an invalid relative path.".to_string());
    }
    let components = path.split('/').collect::<Vec<_>>();
    if components.len() > MAX_RELATIVE_PATH_DEPTH
        || components.iter().any(|component| {
            component.is_empty()
                || component.len() > MAX_PATH_COMPONENT_BYTES
                || matches!(*component, "." | "..")
                || component.contains(':')
                || component.starts_with(' ')
                || component.ends_with([' ', '.'])
                || contains_windows_forbidden_character(component)
                || is_windows_reserved_component(component)
        })
    {
        return Err("A settings entry has an unsafe relative path.".to_string());
    }
    Ok(())
}

pub(crate) fn has_file_ancestor_collision<'a>(aliases: impl IntoIterator<Item = &'a str>) -> bool {
    let aliases = aliases.into_iter().collect::<HashSet<_>>();
    aliases.iter().any(|alias| {
        let mut ancestor = *alias;
        while let Some((parent, _)) = ancestor.rsplit_once('/') {
            if aliases.contains(parent) {
                return true;
            }
            ancestor = parent;
        }
        false
    })
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
            SettingsCategoryId::GlobalInstructions => {
                if entry.relative_path != "instructions.md"
                    && !(entry.relative_path.starts_with("instructions/")
                        && entry.relative_path.ends_with(".instructions.md"))
                {
                    return Err(
                        "An instruction path is outside the allowed global layout.".to_string()
                    );
                }
                validate_frontmatter(&entry.utf8_content)?;
            }
            SettingsCategoryId::GlobalPrompts => {
                if !entry.relative_path.starts_with("prompts/")
                    || !entry.relative_path.ends_with(".prompt.md")
                {
                    return Err("A prompt path is outside the allowed global layout.".to_string());
                }
                validate_frontmatter(&entry.utf8_content)?;
            }
            SettingsCategoryId::GlobalRalphFlows => {
                if let Some(path_flow_id) = ralph_flow_id_from_path(&entry.relative_path) {
                    let value = serde_json::from_str::<Value>(&entry.utf8_content)
                        .map_err(|_| "A RALPH flow contains invalid JSON.".to_string())?;
                    let flow_id = validate_ralph_flow(&value)?;
                    if path_flow_id != flow_id || !flow_ids.insert(flow_id) {
                        return Err("A RALPH flow path or id is invalid or duplicated.".to_string());
                    }
                } else if ralph_instruction_flow_id(&entry.relative_path).is_none() {
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
        for entry in entries
            .iter()
            .filter(|entry| entry.relative_path.starts_with("instructions/"))
        {
            let flow_id = ralph_instruction_flow_id(&entry.relative_path).unwrap_or_default();
            if !flow_ids.contains(flow_id) {
                return Err("A RALPH instruction entry has no matching flow.".to_string());
            }
        }
        validate_ralph_flows_with_core(entries)?;
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

pub(crate) fn category_data_json(
    snapshot: &CategorySnapshot,
) -> Result<&Map<String, Value>, String> {
    match &snapshot.data {
        CategorySnapshotData::Json(Value::Object(value)) => Ok(value),
        _ => Err("The category does not contain JSON settings.".to_string()),
    }
}

pub(crate) fn category_file_entries(
    snapshot: &CategorySnapshot,
) -> Result<&[FileSnapshotEntry], String> {
    match &snapshot.data {
        CategorySnapshotData::Files(entries) => Ok(entries),
        _ => Err("The category does not contain settings files.".to_string()),
    }
}

pub(crate) fn appearance_store_key() -> &'static str {
    APPEARANCE_STORAGE_KEY
}

pub(crate) fn marketplace_store_key() -> &'static str {
    MCP_MARKETPLACE_STORAGE_KEY
}

pub(crate) fn store_file() -> &'static str {
    STORE_FILE
}

pub(crate) fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => {
            for value in values.iter_mut() {
                zeroize_json_value(value);
            }
            values.clear();
        }
        Value::Object(values) => {
            for (mut key, mut value) in std::mem::take(values) {
                key.zeroize();
                zeroize_json_value(&mut value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

pub(crate) fn zeroize_snapshot(snapshot: &mut CategorySnapshot) {
    snapshot.replacement.zeroize();
    snapshot.sha256.zeroize();
    match &mut snapshot.data {
        CategorySnapshotData::Json(value) => zeroize_json_value(value),
        CategorySnapshotData::Files(entries) => {
            for entry in entries.iter_mut() {
                entry.relative_path.zeroize();
                entry.utf8_content.zeroize();
                entry.sha256.zeroize();
            }
            entries.clear();
        }
    }
}

pub(crate) fn zeroize_snapshot_availability(snapshot: &mut SnapshotAvailability) {
    if let SnapshotAvailability::Available(snapshot) = snapshot {
        zeroize_snapshot(snapshot);
    }
}

pub(crate) fn zeroize_snapshots(
    snapshots: &mut BTreeMap<SettingsCategoryId, SnapshotAvailability>,
) {
    for snapshot in snapshots.values_mut() {
        zeroize_snapshot_availability(snapshot);
    }
    snapshots.clear();
}

pub(crate) fn zeroize_envelope(envelope: &mut super::contract::TransferEnvelope) {
    envelope.transfer_id.zeroize();
    for snapshot in &mut envelope.categories {
        zeroize_snapshot(snapshot);
    }
    envelope.categories.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_paths_reject_traversal_aliases_and_non_normalized_unicode() {
        for invalid in [
            "../secret.md",
            "/absolute.md",
            "C:/secret.md",
            "folder\\secret.md",
            "folder/con.txt",
            "folder/COM¹.log",
            "folder/name. ",
            "folder/ leading.prompt.md",
            "folder/question?.prompt.md",
            "folder/control\u{1f}.prompt.md",
            "folder//file.md",
            "prompts/e\u{301}.prompt.md",
        ] {
            assert!(
                validate_wire_path(invalid).is_err(),
                "{invalid} should fail"
            );
        }
        let oversized_component =
            format!("prompts/{}.prompt.md", "a".repeat(MAX_PATH_COMPONENT_BYTES));
        assert!(validate_wire_path(&oversized_component).is_err());
        assert!(validate_wire_path("prompts/é.prompt.md").is_ok());
    }

    #[test]
    fn file_categories_reject_a_file_used_as_an_ancestor_directory() {
        let content = "# Instructions\n";
        let entry = |relative_path: &str| FileSnapshotEntry {
            relative_path: relative_path.to_string(),
            sha256: sha256_hex(content.as_bytes()),
            utf8_content: content.to_string(),
        };
        let entries = vec![
            entry("instructions/review.instructions.md"),
            entry("instructions/review.instructions.md/security.instructions.md"),
        ];

        assert!(
            validate_file_entries(SettingsCategoryId::GlobalInstructions, &entries)
                .expect_err("a file cannot also be an ancestor directory")
                .contains("nested below another file")
        );
    }

    #[test]
    fn api_key_schema_is_closed_and_requires_string_values() {
        assert!(validate_api_keys_value(&json!({
            "apiKeys": { "openai": "secret" },
            "webSearchApiKeys": {}
        }))
        .is_ok());
        assert!(validate_api_keys_value(&json!({
            "apiKeys": { "openai": 12 },
            "webSearchApiKeys": {}
        }))
        .is_err());
        assert!(validate_api_keys_value(&json!({
            "apiKeys": {},
            "webSearchApiKeys": {},
            "workspaceRoot": "poison"
        }))
        .is_err());
        assert!(validate_api_keys_value(&json!({
            "apiKeys": { "future-provider": "secret" },
            "webSearchApiKeys": {}
        }))
        .is_err());
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
            "providerEnrollment": {
                "schemaVersion": 1,
                "enabled": true,
                "instructions": {
                    "mode": "native-when-available",
                    "unmanagedNative": "adopt",
                    "strictConflicts": false,
                    "fallback": "automatic",
                    "failOnTruncation": false
                },
                "mcp": {
                    "mode": "direct-native",
                    "fallback": "per-server-stdio-proxy",
                    "compatibilityServerName": "machdoch-compat",
                    "unmanagedNative": "allow",
                    "approvals": "never",
                    "progressiveDiscoveryThresholdPercent": 3
                },
                "persistentSync": {
                    "enabled": true,
                    "watch": true,
                    "debounceMs": 500,
                    "filesystemConvergenceTargetMs": 2000,
                    "fullRescanIntervalMs": 600000,
                    "autoReloadOwnedSessions": true
                },
                "providers": {
                    "codex-cli": { "enabled": true },
                    "claude-cli": { "enabled": true },
                    "copilot-cli": { "enabled": true }
                }
            }
        });
        assert!(validate_agent_provider_value(&provider).is_ok());
        let mut provider_with_device_field = provider;
        provider_with_device_field["providerEnrollment"]["persistentSync"]["daemonAtLogin"] =
            json!(true);
        assert!(validate_agent_provider_value(&provider_with_device_field).is_err());

        assert!(validate_mcp_config(&json!({
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
        assert!(validate_mcp_config(&json!({
            "servers": [{
                "id": "local-tools",
                "transport": { "type": "stdio", "command": "node", "workspaceRoot": "poison" }
            }]
        }))
        .is_err());
        assert!(validate_mcp_config(&json!({
            "defaults": { "securityProfile": 42 },
            "servers": []
        }))
        .is_err());
    }

    #[test]
    fn ralph_validation_rejects_workspace_specific_flows() {
        let flow = json!({
            "schemaVersion": 1,
            "id": "global-flow",
            "name": "Global flow",
            "blocks": [{
                "id": "start",
                "type": "start",
                "settings": { "workspace": { "mode": "custom", "path": "C:/poison" } }
            }],
            "edges": []
        });
        assert_eq!(
            validate_ralph_flow(&flow).expect_err("workspace flow should fail"),
            "A global RALPH flow declares workspace-specific settings."
        );
    }

    #[test]
    fn ralph_paths_match_only_the_closed_global_layout() {
        assert_eq!(
            ralph_flow_id_from_path("flows/global-flow.json"),
            Some("global-flow")
        );
        assert_eq!(
            ralph_instruction_flow_id("instructions/global-flow/instructions.md"),
            Some("global-flow")
        );
        assert_eq!(
            ralph_instruction_flow_id(
                "instructions/global-flow/instructions/review/security.instructions.md"
            ),
            Some("global-flow")
        );

        for invalid in [
            "flows/nested/global-flow.json",
            "instructions/global-flow/extra/instructions.md",
            "instructions/global-flow/review.instructions.md",
            "instructions/global-flow/instructions/.instructions.md",
            "instructions/global flow/instructions.md",
        ] {
            assert!(
                ralph_flow_id_from_path(invalid).is_none()
                    && ralph_instruction_flow_id(invalid).is_none(),
                "{invalid} should not match a managed RALPH path"
            );
        }
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
    fn ralph_transfer_uses_the_complete_core_graph_validator() {
        let valid = serde_json::json!({
            "schemaVersion": 1,
            "id": "transfer-flow",
            "name": "Transfer flow",
            "blocks": [
                { "id": "start", "type": "START", "title": "Start" },
                { "id": "work", "type": "PROMPT", "title": "Work", "prompt": "Do the work." },
                { "id": "done", "type": "END", "title": "Done", "status": "success" }
            ],
            "edges": [
                { "id": "start-work", "from": "start", "fromOutput": "SUCCESS", "to": "work" },
                { "id": "work-done", "from": "work", "fromOutput": "SUCCESS", "to": "done" }
            ]
        })
        .to_string();
        let entry = FileSnapshotEntry {
            relative_path: "flows/transfer-flow.json".to_string(),
            sha256: sha256_hex(valid.as_bytes()),
            utf8_content: valid,
        };
        validate_ralph_flows_with_core(std::slice::from_ref(&entry))
            .expect("a complete valid graph should pass the shared validator");

        let invalid = serde_json::json!({
            "schemaVersion": 1,
            "id": "transfer-flow",
            "name": "Transfer flow",
            "blocks": [
                { "id": "start", "type": "START", "title": "Start" },
                { "id": "second-start", "type": "START", "title": "Second start" }
            ],
            "edges": []
        })
        .to_string();
        let invalid_entry = FileSnapshotEntry {
            relative_path: "flows/transfer-flow.json".to_string(),
            sha256: sha256_hex(invalid.as_bytes()),
            utf8_content: invalid,
        };
        assert!(
            validate_ralph_flows_with_core(std::slice::from_ref(&invalid_entry)).is_err(),
            "a graph with two START blocks must fail complete graph validation"
        );
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
