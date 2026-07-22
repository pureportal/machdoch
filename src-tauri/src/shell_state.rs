use std::{
    collections::{BTreeMap, HashSet},
    fs,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};
use crate::cooperative_file_lock::with_cooperative_file_lock;

const STORE_FILE: &str = "machdoch-shell-state.json";
const SNAPSHOT_FILE: &str = "machdoch-shell-state.snapshot.json";
const SNAPSHOT_REVISION_FILE: &str = "machdoch-shell-state.snapshot.revision";
const SHELL_STATE_STORAGE_KEY: &str = "machdoch.desktop.shell-state";
const SHELL_STATE_REVISION_KEY: &str = "machdoch.desktop.shell-state-revision";
const TOMBSTONES_KEY: &str = "__machdochTombstones";
const MAX_TOMBSTONES_PER_KIND: usize = 50_000;
const CHAT_VOICE_OWNED_SHELL_KEYS: [&str; 7] = [
    "voice",
    "lastSelectedProvider",
    "lastSelectedModelByProvider",
    "lastSelectedMode",
    "lastSelectedReasoning",
    "lastSelectedSessionMemoryEnabled",
    "lastSelectedUseGlobalMemory",
];
const CHAT_VOICE_UI_CONTROL_KEY: &str = "lastSelectedUiControlEnabled";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ShellStateTombstones {
    sessions: BTreeMap<String, u64>,
    messages: BTreeMap<String, u64>,
    queued_messages: BTreeMap<String, u64>,
    context_packs: BTreeMap<String, u64>,
}

/// Serializes shell-state compare-and-swap operations across every webview.
///
/// The store plugin protects an individual `get` or `set`, but the UI needs the
/// complete read/merge/write sequence to be atomic. Keeping the revision and
/// value behind this process-wide lock prevents one webview from silently
/// overwriting a newer commit made by another webview.
#[derive(Default)]
pub struct ShellStateStoreLock(Mutex<Option<ShellStateSnapshot>>);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateSnapshot {
    state: Value,
    revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateCompareAndSwapRequest {
    expected_revision: u64,
    state: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStatePatchRequest {
    expected_revision: u64,
    top_level: BTreeMap<String, Value>,
    removed_top_level: Vec<String>,
    sessions: Vec<Value>,
    session_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateCompareAndSwapResponse {
    committed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<Value>,
    revision: u64,
}

async fn run_snapshot_io<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Shell-state storage task failed: {error}"))?
}

async fn load_cached_snapshot(
    app_handle: &AppHandle,
    cache: &mut Option<ShellStateSnapshot>,
    fallback: Value,
) -> Result<ShellStateSnapshot, String> {
    if let Some(snapshot) = cache.as_ref() {
        return Ok(snapshot.clone());
    }

    let app_handle = app_handle.clone();
    let snapshot = run_snapshot_io(move || {
        let path = snapshot_path(&app_handle)?;
        with_cooperative_file_lock(&path, || load_snapshot(&app_handle, fallback))
    })
    .await?;
    *cache = Some(snapshot.clone());
    Ok(snapshot)
}

fn load_cached_snapshot_blocking<R: Runtime>(
    app_handle: &AppHandle<R>,
    cache: &mut Option<ShellStateSnapshot>,
    fallback: Value,
) -> Result<ShellStateSnapshot, String> {
    if let Some(snapshot) = cache.as_ref() {
        return Ok(snapshot.clone());
    }

    let path = snapshot_path(app_handle)?;
    let snapshot = with_cooperative_file_lock(&path, || load_snapshot(app_handle, fallback))?;
    *cache = Some(snapshot.clone());
    Ok(snapshot)
}

fn read_revision(value: Option<Value>) -> u64 {
    value.and_then(|entry| entry.as_u64()).unwrap_or(0)
}

fn collect_ids(state: &Value, field: &str) -> HashSet<String> {
    state
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn collect_message_ids(state: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Some(sessions) = state.get("sessions").and_then(Value::as_array) else {
        return ids;
    };

    for session in sessions {
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(messages) = session.get("messages").and_then(Value::as_array) else {
            continue;
        };

        for message in messages {
            if let Some(message_id) = message.get("id").and_then(Value::as_str) {
                ids.insert(message_tombstone_key(session_id, message_id));
            }
        }
    }

    ids
}

fn message_tombstone_key(session_id: &str, message_id: &str) -> String {
    format!("{}:{session_id}{message_id}", session_id.len())
}

fn record_removed_ids(
    current_ids: HashSet<String>,
    next_ids: HashSet<String>,
    tombstones: &mut BTreeMap<String, u64>,
    revision: u64,
) {
    for removed_id in current_ids.difference(&next_ids) {
        tombstones.insert(removed_id.clone(), revision);
    }
}

fn retain_live_entries(value: &mut Value, field: &str, tombstones: &BTreeMap<String, u64>) {
    let Some(entries) = value.get_mut(field).and_then(Value::as_array_mut) else {
        return;
    };

    entries.retain(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(|id| !tombstones.contains_key(id))
    });
}

fn retain_live_messages(value: &mut Value, tombstones: &BTreeMap<String, u64>) {
    let Some(sessions) = value.get_mut("sessions").and_then(Value::as_array_mut) else {
        return;
    };

    for session in sessions {
        let Some(session_id) = session
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let Some(messages) = session.get_mut("messages").and_then(Value::as_array_mut) else {
            continue;
        };

        messages.retain(|message| {
            message
                .get("id")
                .and_then(Value::as_str)
                .is_none_or(|id| !tombstones.contains_key(&message_tombstone_key(&session_id, id)))
        });
    }
}

fn trim_tombstones(tombstones: &mut BTreeMap<String, u64>) {
    if tombstones.len() <= MAX_TOMBSTONES_PER_KIND {
        return;
    }

    let mut entries = tombstones
        .iter()
        .map(|(id, revision)| (id.clone(), *revision))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    tombstones.clear();
    tombstones.extend(entries.into_iter().take(MAX_TOMBSTONES_PER_KIND));
}

fn prepare_next_state(current: &Value, mut requested: Value, revision: u64) -> Value {
    let mut tombstones = current
        .get(TOMBSTONES_KEY)
        .cloned()
        .and_then(|value| serde_json::from_value::<ShellStateTombstones>(value).ok())
        .unwrap_or_default();

    retain_live_entries(&mut requested, "sessions", &tombstones.sessions);
    retain_live_entries(
        &mut requested,
        "queuedSessionMessages",
        &tombstones.queued_messages,
    );
    retain_live_entries(&mut requested, "contextPacks", &tombstones.context_packs);
    retain_live_messages(&mut requested, &tombstones.messages);

    record_removed_ids(
        collect_ids(current, "sessions"),
        collect_ids(&requested, "sessions"),
        &mut tombstones.sessions,
        revision,
    );
    record_removed_ids(
        collect_ids(current, "queuedSessionMessages"),
        collect_ids(&requested, "queuedSessionMessages"),
        &mut tombstones.queued_messages,
        revision,
    );
    record_removed_ids(
        collect_ids(current, "contextPacks"),
        collect_ids(&requested, "contextPacks"),
        &mut tombstones.context_packs,
        revision,
    );
    record_removed_ids(
        collect_message_ids(current),
        collect_message_ids(&requested),
        &mut tombstones.messages,
        revision,
    );

    trim_tombstones(&mut tombstones.sessions);
    trim_tombstones(&mut tombstones.messages);
    trim_tombstones(&mut tombstones.queued_messages);
    trim_tombstones(&mut tombstones.context_packs);

    if let Some(requested_object) = requested.as_object_mut() {
        if let Ok(serialized_tombstones) = serde_json::to_value(tombstones) {
            requested_object.insert(TOMBSTONES_KEY.to_string(), serialized_tombstones);
        }
    }

    requested
}

fn prepare_context_pack_replacement(
    current: &Value,
    context_packs: Vec<Value>,
    revision: u64,
) -> Result<Value, String> {
    let mut current = current.clone();
    let current_object = current
        .as_object_mut()
        .ok_or_else(|| "The persisted shell state is invalid.".to_string())?;
    let mut tombstones = current_object
        .get(TOMBSTONES_KEY)
        .cloned()
        .and_then(|value| serde_json::from_value::<ShellStateTombstones>(value).ok())
        .unwrap_or_default();
    for id in context_packs
        .iter()
        .filter_map(|pack| pack.get("id").and_then(Value::as_str))
    {
        tombstones.context_packs.remove(id);
    }
    current_object.insert(
        TOMBSTONES_KEY.to_string(),
        serde_json::to_value(tombstones)
            .map_err(|_| "The context-pack tombstones are invalid.".to_string())?,
    );

    let mut requested = current.clone();
    requested
        .as_object_mut()
        .ok_or_else(|| "The persisted shell state is invalid.".to_string())?
        .insert("contextPacks".to_string(), Value::Array(context_packs));
    Ok(prepare_next_state(&current, requested, revision))
}

fn replace_optional_member(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    source_key: &str,
    target_key: &str,
) -> Result<(), String> {
    match source.get(source_key) {
        Some(Value::Null) => {
            target.remove(target_key);
        }
        Some(value) => {
            target.insert(target_key.to_string(), value.clone());
        }
        None => return Err("A transferred shell preference is missing.".to_string()),
    }
    Ok(())
}

fn capture_member(root: &Map<String, Value>, key: &str) -> Value {
    json!({
        "present": root.contains_key(key),
        "value": root.get(key).cloned().unwrap_or(Value::Null),
    })
}

fn restore_captured_member(
    target: &mut Map<String, Value>,
    backup: &Map<String, Value>,
    key: &str,
) -> Result<(), String> {
    let entry = backup
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| "A shell-state rollback field is invalid.".to_string())?;
    if entry.len() != 2
        || !entry.contains_key("present")
        || !entry.contains_key("value")
        || !entry.get("present").is_some_and(Value::is_boolean)
    {
        return Err("A shell-state rollback field is invalid.".to_string());
    }
    if entry.get("present").and_then(Value::as_bool) == Some(true) {
        target.insert(
            key.to_string(),
            entry
                .get("value")
                .cloned()
                .ok_or_else(|| "A shell-state rollback value is missing.".to_string())?,
        );
    } else {
        target.remove(key);
    }
    Ok(())
}

fn capture_chat_voice_owned_fields(current: &Value) -> Result<Value, String> {
    let current = current
        .as_object()
        .ok_or_else(|| "The persisted shell state is invalid.".to_string())?;
    let mut backup = Map::new();
    for key in CHAT_VOICE_OWNED_SHELL_KEYS
        .into_iter()
        .chain(std::iter::once(CHAT_VOICE_UI_CONTROL_KEY))
    {
        backup.insert(key.to_string(), capture_member(current, key));
    }
    Ok(Value::Object(backup))
}

fn prepare_chat_voice_owned_fields_restore(
    current: &Value,
    backup: &Value,
    revision: u64,
) -> Result<Value, String> {
    let backup = backup
        .as_object()
        .ok_or_else(|| "The chat-preference rollback projection is invalid.".to_string())?;
    if backup.len() != CHAT_VOICE_OWNED_SHELL_KEYS.len() + 1 {
        return Err("The chat-preference rollback projection is invalid.".to_string());
    }
    let mut requested = current.clone();
    let requested = requested
        .as_object_mut()
        .ok_or_else(|| "The persisted shell state is invalid.".to_string())?;
    for key in CHAT_VOICE_OWNED_SHELL_KEYS
        .into_iter()
        .chain(std::iter::once(CHAT_VOICE_UI_CONTROL_KEY))
    {
        restore_captured_member(requested, backup, key)?;
    }
    Ok(prepare_next_state(
        current,
        Value::Object(requested.clone()),
        revision,
    ))
}

fn prepare_chat_voice_preference_replacement(
    current: &Value,
    preferences: &Value,
    revision: u64,
) -> Result<Value, String> {
    let source = preferences
        .as_object()
        .ok_or_else(|| "Transferred chat and voice preferences are invalid.".to_string())?;
    let incoming_voice = source
        .get("voice")
        .and_then(Value::as_object)
        .ok_or_else(|| "Transferred spoken-reply preferences are invalid.".to_string())?;
    let new_chat = source
        .get("newChat")
        .and_then(Value::as_object)
        .ok_or_else(|| "Transferred new-chat defaults are invalid.".to_string())?;
    let mut requested = current.clone();
    let requested = requested
        .as_object_mut()
        .ok_or_else(|| "The persisted shell state is invalid.".to_string())?;

    let mut voice = requested
        .get("voice")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in ["autoSpeakResponses", "rate"] {
        let value = incoming_voice
            .get(key)
            .ok_or_else(|| "A transferred spoken-reply preference is missing.".to_string())?;
        voice.insert(key.to_string(), value.clone());
    }
    requested.insert("voice".to_string(), Value::Object(voice));

    for (source_key, target_key) in [
        ("provider", "lastSelectedProvider"),
        ("models", "lastSelectedModelByProvider"),
        ("sessionMemoryEnabled", "lastSelectedSessionMemoryEnabled"),
        ("useGlobalMemory", "lastSelectedUseGlobalMemory"),
        ("uiControlEnabled", "lastSelectedUiControlEnabled"),
    ] {
        let value = new_chat
            .get(source_key)
            .ok_or_else(|| "A transferred new-chat preference is missing.".to_string())?;
        requested.insert(target_key.to_string(), value.clone());
    }
    replace_optional_member(requested, new_chat, "mode", "lastSelectedMode")?;
    replace_optional_member(requested, new_chat, "reasoning", "lastSelectedReasoning")?;
    Ok(prepare_next_state(
        current,
        Value::Object(requested.clone()),
        revision,
    ))
}

fn snapshot_path<R: Runtime>(app_handle: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    app_handle
        .path()
        .resolve(SNAPSHOT_FILE, BaseDirectory::AppData)
        .map_err(|error| format!("Failed to resolve the shell-state snapshot path: {error}"))
}

fn apply_shell_state_patch(current: &Value, patch: ShellStatePatchRequest) -> Value {
    let mut requested = current.clone();
    let Some(requested_object) = requested.as_object_mut() else {
        return requested;
    };

    for (key, value) in patch.top_level {
        if key != "sessions" && key != TOMBSTONES_KEY {
            requested_object.insert(key, value);
        }
    }

    for key in patch.removed_top_level {
        if key != "sessions" && key != TOMBSTONES_KEY {
            requested_object.remove(&key);
        }
    }

    let mut sessions_by_id = requested_object
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|session| {
            let id = session.get("id")?.as_str()?.to_string();
            Some((id, session.clone()))
        })
        .collect::<BTreeMap<_, _>>();

    for session in patch.sessions {
        let Some(id) = session
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };

        sessions_by_id.insert(id, session);
    }

    requested_object.insert(
        "sessions".to_string(),
        Value::Array(
            patch
                .session_order
                .into_iter()
                .filter_map(|session_id| sessions_by_id.remove(&session_id))
                .collect(),
        ),
    );

    requested
}

fn snapshot_revision_path<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    app_handle
        .path()
        .resolve(SNAPSHOT_REVISION_FILE, BaseDirectory::AppData)
        .map_err(|error| format!("Failed to resolve the shell-state revision path: {error}"))
}

fn persist_snapshot_revision<R: Runtime>(
    app_handle: &AppHandle<R>,
    revision: u64,
) -> Result<(), String> {
    let revision_path = snapshot_revision_path(app_handle)?;
    write_file_atomic(
        &revision_path,
        revision.to_string().as_bytes(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| {
        format!(
            "Failed to persist the shell-state revision {}: {error}",
            revision_path.display()
        )
    })
}

fn load_snapshot_revision<R: Runtime>(app_handle: &AppHandle<R>) -> Result<u64, String> {
    let revision_path = snapshot_revision_path(app_handle)?;

    if revision_path.exists() {
        let raw = fs::read_to_string(&revision_path).map_err(|error| {
            format!(
                "Failed to read the shell-state revision {}: {error}",
                revision_path.display()
            )
        })?;

        return raw.trim().parse::<u64>().map_err(|error| {
            format!(
                "Failed to parse the shell-state revision {}: {error}",
                revision_path.display()
            )
        });
    }

    let snapshot = load_snapshot(app_handle, Value::Null)?;
    persist_snapshot_revision(app_handle, snapshot.revision)?;
    Ok(snapshot.revision)
}

fn ensure_snapshot_revision<R: Runtime>(
    app_handle: &AppHandle<R>,
    revision: u64,
) -> Result<(), String> {
    if load_snapshot_revision(app_handle).ok() == Some(revision) {
        return Ok(());
    }

    persist_snapshot_revision(app_handle, revision)
}

fn load_snapshot<R: Runtime>(
    app_handle: &AppHandle<R>,
    fallback: Value,
) -> Result<ShellStateSnapshot, String> {
    let snapshot_path = snapshot_path(app_handle)?;

    if snapshot_path.exists() {
        let raw = fs::read_to_string(&snapshot_path).map_err(|error| {
            format!(
                "Failed to read the shell-state snapshot {}: {error}",
                snapshot_path.display()
            )
        })?;

        return serde_json::from_str::<ShellStateSnapshot>(&raw).map_err(|error| {
            format!(
                "Failed to parse the shell-state snapshot {}: {error}",
                snapshot_path.display()
            )
        });
    }

    // One-time migration from the previous plugin-store representation. The
    // dedicated snapshot file is used for every later compare-and-swap so a
    // failed store save cannot expose an uncommitted cache mutation.
    let store = app_handle
        .store(STORE_FILE)
        .map_err(|error| format!("Failed to open the legacy shell-state store: {error}"))?;

    Ok(ShellStateSnapshot {
        state: store.get(SHELL_STATE_STORAGE_KEY).unwrap_or(fallback),
        revision: read_revision(store.get(SHELL_STATE_REVISION_KEY)),
    })
}

fn persist_snapshot<R: Runtime>(
    app_handle: &AppHandle<R>,
    snapshot: &ShellStateSnapshot,
) -> Result<(), String> {
    let snapshot_path = snapshot_path(app_handle)?;

    if let Some(parent) = snapshot_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create the shell-state snapshot directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let serialized = serde_json::to_string(snapshot)
        .map_err(|error| format!("Failed to serialize the shell-state snapshot: {error}"))?;
    let raw = format!("{serialized}\n");

    write_file_atomic(
        &snapshot_path,
        raw.as_bytes(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| {
        format!(
            "Failed to persist the shell-state snapshot {}: {error}",
            snapshot_path.display()
        )
    })?;

    persist_snapshot_revision(app_handle, snapshot.revision)?;
    let _ = remove_migrated_legacy_shell_state(app_handle);
    Ok(())
}

fn remove_migrated_legacy_shell_state<R: Runtime>(app_handle: &AppHandle<R>) -> Result<(), String> {
    let store = app_handle
        .store(STORE_FILE)
        .map_err(|error| format!("Failed to open the legacy shell-state store: {error}"))?;

    if !store.has(SHELL_STATE_STORAGE_KEY) && !store.has(SHELL_STATE_REVISION_KEY) {
        return Ok(());
    }

    store.delete(SHELL_STATE_STORAGE_KEY);
    store.delete(SHELL_STATE_REVISION_KEY);
    store
        .save()
        .map_err(|error| format!("Failed to compact the legacy shell-state store: {error}"))
}

/// Reads the authoritative shell state from a settings-transfer worker thread.
///
/// Settings transfer runs its blocking snapshot and transaction work through
/// `spawn_blocking`, so it can share the same cache mutex and revisioned file as
/// the asynchronous UI commands without maintaining a second shell-state DTO.
pub(crate) fn load_shell_state_for_settings_transfer<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<Value, String> {
    let state = app_handle.state::<ShellStateStoreLock>();
    let mut cache = state.0.blocking_lock();
    let snapshot =
        load_cached_snapshot_blocking(app_handle, &mut cache, json!({ "contextPacks": [] }))?;
    Ok(snapshot.state)
}

pub(crate) fn capture_chat_voice_owned_fields_for_settings_transfer<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<Value, String> {
    let state = app_handle.state::<ShellStateStoreLock>();
    let mut cache = state.0.blocking_lock();
    let current = load_cached_snapshot_blocking(app_handle, &mut cache, json!({}))?;
    capture_chat_voice_owned_fields(&current.state)
}

pub(crate) fn validate_chat_voice_owned_fields_backup(backup: &Value) -> Result<(), String> {
    let _ = prepare_chat_voice_owned_fields_restore(&json!({}), backup, 1)?;
    Ok(())
}

/// Replaces the complete persisted context-pack list through the same CAS
/// snapshot used by the desktop UI. Callers are responsible for preserving
/// every pack outside the category they own.
pub(crate) fn replace_context_packs_for_settings_transfer<R: Runtime>(
    app_handle: &AppHandle<R>,
    context_packs: Vec<Value>,
) -> Result<u64, String> {
    let state = app_handle.state::<ShellStateStoreLock>();
    let mut cache = state.0.blocking_lock();
    let current =
        load_cached_snapshot_blocking(app_handle, &mut cache, json!({ "contextPacks": [] }))?;
    let revision = current.revision.saturating_add(1);
    let snapshot = ShellStateSnapshot {
        state: prepare_context_pack_replacement(&current.state, context_packs, revision)?,
        revision,
    };
    let path = snapshot_path(app_handle)?;
    with_cooperative_file_lock(&path, || persist_snapshot(app_handle, &snapshot))?;
    *cache = Some(snapshot);
    Ok(revision)
}

pub(crate) fn replace_chat_voice_preferences_for_settings_transfer<R: Runtime>(
    app_handle: &AppHandle<R>,
    preferences: &Value,
) -> Result<u64, String> {
    let state = app_handle.state::<ShellStateStoreLock>();
    let mut cache = state.0.blocking_lock();
    let current = load_cached_snapshot_blocking(app_handle, &mut cache, json!({}))?;
    let revision = current.revision.saturating_add(1);
    let snapshot = ShellStateSnapshot {
        state: prepare_chat_voice_preference_replacement(&current.state, preferences, revision)?,
        revision,
    };
    let path = snapshot_path(app_handle)?;
    with_cooperative_file_lock(&path, || persist_snapshot(app_handle, &snapshot))?;
    *cache = Some(snapshot);
    Ok(revision)
}

pub(crate) fn restore_chat_voice_owned_fields_for_settings_transfer<R: Runtime>(
    app_handle: &AppHandle<R>,
    backup: &Value,
) -> Result<u64, String> {
    let state = app_handle.state::<ShellStateStoreLock>();
    let mut cache = state.0.blocking_lock();
    let current = load_cached_snapshot_blocking(app_handle, &mut cache, json!({}))?;
    let revision = current.revision.saturating_add(1);
    let snapshot = ShellStateSnapshot {
        state: prepare_chat_voice_owned_fields_restore(&current.state, backup, revision)?,
        revision,
    };
    let path = snapshot_path(app_handle)?;
    with_cooperative_file_lock(&path, || persist_snapshot(app_handle, &snapshot))?;
    *cache = Some(snapshot);
    Ok(revision)
}

#[tauri::command]
pub async fn load_shell_state_snapshot(
    app_handle: AppHandle,
    lock: tauri::State<'_, ShellStateStoreLock>,
    fallback: Value,
) -> Result<ShellStateSnapshot, String> {
    let mut cache = lock.0.lock().await;
    let snapshot = load_cached_snapshot(&app_handle, &mut cache, fallback).await?;
    let revision = snapshot.revision;
    let app_handle = app_handle.clone();
    run_snapshot_io(move || ensure_snapshot_revision(&app_handle, revision)).await?;
    Ok(snapshot)
}

#[tauri::command]
pub async fn load_shell_state_revision(
    app_handle: AppHandle,
    lock: tauri::State<'_, ShellStateStoreLock>,
) -> Result<u64, String> {
    let cache = lock.0.lock().await;

    if let Some(snapshot) = cache.as_ref() {
        return Ok(snapshot.revision);
    }

    drop(cache);
    run_snapshot_io(move || load_snapshot_revision(&app_handle)).await
}

#[tauri::command]
pub async fn compare_and_swap_shell_state(
    app_handle: AppHandle,
    lock: tauri::State<'_, ShellStateStoreLock>,
    request: ShellStateCompareAndSwapRequest,
) -> Result<ShellStateCompareAndSwapResponse, String> {
    let mut cache = lock.0.lock().await;
    commit_requested_state(
        &app_handle,
        &mut cache,
        request.expected_revision,
        request.state,
    )
    .await
}

#[tauri::command]
pub async fn compare_and_swap_shell_state_patch(
    app_handle: AppHandle,
    lock: tauri::State<'_, ShellStateStoreLock>,
    request: ShellStatePatchRequest,
) -> Result<ShellStateCompareAndSwapResponse, String> {
    let mut cache = lock.0.lock().await;
    let current = load_cached_snapshot(&app_handle, &mut cache, Value::Null).await?;
    let expected_revision = request.expected_revision;

    if current.revision != expected_revision {
        return Ok(ShellStateCompareAndSwapResponse {
            committed: false,
            state: Some(current.state),
            revision: current.revision,
        });
    }

    let requested = apply_shell_state_patch(&current.state, request);
    commit_requested_state(&app_handle, &mut cache, expected_revision, requested).await
}

async fn commit_requested_state(
    app_handle: &AppHandle,
    cache: &mut Option<ShellStateSnapshot>,
    expected_revision: u64,
    requested: Value,
) -> Result<ShellStateCompareAndSwapResponse, String> {
    let current = load_cached_snapshot(app_handle, cache, Value::Null).await?;
    let current_revision = current.revision;

    if current_revision != expected_revision {
        return Ok(ShellStateCompareAndSwapResponse {
            committed: false,
            state: Some(current.state),
            revision: current_revision,
        });
    }

    let next_revision = current_revision.saturating_add(1);
    let next_state = prepare_next_state(&current.state, requested, next_revision);
    let snapshot = ShellStateSnapshot {
        state: next_state,
        revision: next_revision,
    };
    let app_handle_for_io = app_handle.clone();
    let snapshot = run_snapshot_io(move || {
        let path = snapshot_path(&app_handle_for_io)?;
        with_cooperative_file_lock(&path, || {
            persist_snapshot(&app_handle_for_io, &snapshot)?;
            Ok(snapshot)
        })
    })
    .await?;
    *cache = Some(snapshot);

    Ok(ShellStateCompareAndSwapResponse {
        committed: true,
        state: None,
        revision: next_revision,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_shell_state_patch, capture_chat_voice_owned_fields,
        prepare_chat_voice_owned_fields_restore, prepare_chat_voice_preference_replacement,
        prepare_context_pack_replacement, prepare_next_state, read_revision,
        ShellStatePatchRequest, TOMBSTONES_KEY,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn revisions_default_to_zero_and_accept_unsigned_numbers() {
        assert_eq!(read_revision(None), 0);
        assert_eq!(read_revision(Some(json!("invalid"))), 0);
        assert_eq!(read_revision(Some(json!(42))), 42);
    }

    #[test]
    fn patches_replace_changed_sessions_and_preserve_requested_order() {
        let current = json!({
            "activeSessionId": "one",
            "sessions": [
                { "id": "one", "title": "Before" },
                { "id": "two", "title": "Second" },
                { "id": "deleted", "title": "Deleted" }
            ]
        });
        let patched = apply_shell_state_patch(
            &current,
            ShellStatePatchRequest {
                expected_revision: 1,
                top_level: BTreeMap::from([("activeSessionId".to_string(), json!("two"))]),
                removed_top_level: Vec::new(),
                sessions: vec![json!({ "id": "one", "title": "After" })],
                session_order: vec!["two".to_string(), "one".to_string()],
            },
        );

        assert_eq!(patched["activeSessionId"], json!("two"));
        assert_eq!(
            patched["sessions"],
            json!([
                { "id": "two", "title": "Second" },
                { "id": "one", "title": "After" }
            ])
        );
    }

    #[test]
    fn deleted_sessions_and_messages_cannot_be_resurrected_by_a_stale_commit() {
        let current = json!({
            "version": 1,
            "sessions": [{
                "id": "session-1",
                "messages": [{ "id": "message-1" }, { "id": "message-2" }]
            }],
            "queuedSessionMessages": [],
            "contextPacks": []
        });
        let cleared = prepare_next_state(
            &current,
            json!({
                "version": 1,
                "sessions": [{ "id": "session-1", "messages": [] }],
                "queuedSessionMessages": [],
                "contextPacks": []
            }),
            2,
        );
        let stale_resurrection = prepare_next_state(
            &cleared,
            json!({
                "version": 1,
                "sessions": [{
                    "id": "session-1",
                    "messages": [{ "id": "message-1" }, { "id": "message-2" }]
                }],
                "queuedSessionMessages": [],
                "contextPacks": []
            }),
            3,
        );

        assert_eq!(
            stale_resurrection["sessions"][0]["messages"]
                .as_array()
                .map(Vec::len),
            Some(0)
        );
        assert_eq!(
            stale_resurrection[TOMBSTONES_KEY]["messages"]["9:session-1message-1"],
            json!(2)
        );
    }

    #[test]
    fn branch_message_tombstones_are_scoped_to_the_session() {
        let current = json!({
            "version": 1,
            "sessions": [
                { "id": "original", "messages": [{ "id": "shared-message" }] },
                { "id": "branch", "messages": [{ "id": "shared-message" }] }
            ],
            "queuedSessionMessages": [],
            "contextPacks": []
        });
        let branch_cleared = prepare_next_state(
            &current,
            json!({
                "version": 1,
                "sessions": [
                    { "id": "original", "messages": [{ "id": "shared-message" }] },
                    { "id": "branch", "messages": [] }
                ],
                "queuedSessionMessages": [],
                "contextPacks": []
            }),
            2,
        );
        let stale = prepare_next_state(&branch_cleared, current, 3);

        assert_eq!(
            stale["sessions"][0]["messages"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(
            stale["sessions"][1]["messages"].as_array().map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn deleted_top_level_entities_remain_deleted() {
        let current = json!({
            "version": 1,
            "sessions": [{ "id": "session-1", "messages": [] }],
            "queuedSessionMessages": [{ "id": "queued-1" }],
            "contextPacks": [{ "id": "pack-1" }]
        });
        let deleted = prepare_next_state(
            &current,
            json!({
                "version": 1,
                "sessions": [],
                "queuedSessionMessages": [],
                "contextPacks": []
            }),
            2,
        );
        let stale = prepare_next_state(&deleted, current, 3);

        assert!(stale["sessions"].as_array().is_some_and(Vec::is_empty));
        assert!(stale["queuedSessionMessages"]
            .as_array()
            .is_some_and(Vec::is_empty));
        assert!(stale["contextPacks"].as_array().is_some_and(Vec::is_empty));
    }

    #[test]
    fn authoritative_context_pack_replacement_clears_restored_id_tombstones() {
        let current = json!({
            "version": 2,
            "sessions": [],
            "queuedSessionMessages": [],
            "contextPacks": [{ "id": "new-global", "workspace": null }],
            "__machdochTombstones": {
                "sessions": {},
                "messages": {},
                "queuedMessages": {},
                "contextPacks": { "old-global": 2 }
            }
        });
        let restored = prepare_context_pack_replacement(
            &current,
            vec![json!({ "id": "old-global", "workspace": null })],
            3,
        )
        .expect("an authoritative rollback should restore the old pack id");

        assert_eq!(restored["contextPacks"][0]["id"], json!("old-global"));
        assert!(restored[TOMBSTONES_KEY]["contextPacks"]
            .get("old-global")
            .is_none());
        assert_eq!(
            restored[TOMBSTONES_KEY]["contextPacks"]["new-global"],
            json!(3)
        );
    }

    #[test]
    fn chat_voice_replacement_preserves_machine_local_and_unrelated_state() {
        let current = json!({
            "sessions": [{ "id": "session-1" }],
            "contextPacks": [{ "id": "pack-1" }],
            "voice": {
                "autoSpeakResponses": false,
                "rate": 1.0,
                "preferredVoiceURI": "local-voice"
            },
            "lastSelectedProvider": "openai",
            "lastSelectedModelByProvider": { "openai": "old-model" },
            "lastSelectedMode": "ask",
            "lastSelectedReasoning": "low",
            "lastSelectedSessionMemoryEnabled": true,
            "lastSelectedUseGlobalMemory": true,
            "lastSelectedUiControlEnabled": false
        });
        let preferences = json!({
            "voice": { "autoSpeakResponses": true, "rate": 1.25 },
            "newChat": {
                "provider": "anthropic",
                "models": { "anthropic": "claude-test" },
                "mode": null,
                "reasoning": "high",
                "sessionMemoryEnabled": false,
                "useGlobalMemory": false,
                "uiControlEnabled": true
            },
            "runningTaskMessageAction": "steer"
        });

        let replaced = prepare_chat_voice_preference_replacement(&current, &preferences, 2)
            .expect("portable chat and voice preferences should apply");

        assert_eq!(replaced["sessions"], current["sessions"]);
        assert_eq!(replaced["contextPacks"], current["contextPacks"]);
        assert_eq!(replaced["voice"]["preferredVoiceURI"], json!("local-voice"));
        assert_eq!(replaced["voice"]["autoSpeakResponses"], json!(true));
        assert_eq!(replaced["voice"]["rate"], json!(1.25));
        assert_eq!(replaced["lastSelectedProvider"], json!("anthropic"));
        assert!(replaced.get("lastSelectedMode").is_none());
        assert_eq!(replaced["lastSelectedReasoning"], json!("high"));
        assert_eq!(replaced["lastSelectedUiControlEnabled"], json!(true));
    }

    #[test]
    fn chat_voice_rollback_restores_exact_owned_field_presence() {
        let original = json!({
            "sessions": [{ "id": "session-1" }],
            "voice": { "preferredVoiceURI": "local-voice" },
            "lastSelectedProvider": "openai"
        });
        let backup = capture_chat_voice_owned_fields(&original)
            .expect("the exact owned projection should be captured");
        let changed = json!({
            "sessions": [{ "id": "session-1" }],
            "voice": {
                "preferredVoiceURI": "local-voice",
                "autoSpeakResponses": true,
                "rate": 1.3
            },
            "lastSelectedProvider": "anthropic",
            "lastSelectedModelByProvider": { "anthropic": "claude-test" },
            "lastSelectedMode": "machdoch",
            "lastSelectedReasoning": "high",
            "lastSelectedSessionMemoryEnabled": false,
            "lastSelectedUseGlobalMemory": false,
            "lastSelectedUiControlEnabled": true
        });

        let restored = prepare_chat_voice_owned_fields_restore(&changed, &backup, 3)
            .expect("the exact owned projection should restore");

        assert_eq!(restored["sessions"], original["sessions"]);
        assert_eq!(restored["voice"], original["voice"]);
        assert_eq!(restored["lastSelectedProvider"], "openai");
        for absent in [
            "lastSelectedModelByProvider",
            "lastSelectedMode",
            "lastSelectedReasoning",
            "lastSelectedSessionMemoryEnabled",
            "lastSelectedUseGlobalMemory",
            "lastSelectedUiControlEnabled",
        ] {
            assert!(restored.get(absent).is_none(), "{absent} should be absent");
        }
    }
}
