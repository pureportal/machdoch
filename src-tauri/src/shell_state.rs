use std::{
    collections::{BTreeMap, HashSet},
    fs,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};
use crate::cooperative_file_lock::with_cooperative_file_lock;

const STORE_FILE: &str = "machdoch-shell-state.json";
const SNAPSHOT_FILE: &str = "machdoch-shell-state.snapshot.json";
const SHELL_STATE_STORAGE_KEY: &str = "machdoch.desktop.shell-state";
const SHELL_STATE_REVISION_KEY: &str = "machdoch.desktop.shell-state-revision";
const TOMBSTONES_KEY: &str = "__machdochTombstones";
const MAX_TOMBSTONES_PER_KIND: usize = 50_000;

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
pub struct ShellStateStoreLock(Mutex<()>);

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateCompareAndSwapResponse {
    committed: bool,
    state: Value,
    revision: u64,
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

fn snapshot_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    app_handle
        .path()
        .resolve(SNAPSHOT_FILE, BaseDirectory::AppData)
        .map_err(|error| format!("Failed to resolve the shell-state snapshot path: {error}"))
}

fn load_snapshot(app_handle: &AppHandle, fallback: Value) -> Result<ShellStateSnapshot, String> {
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

fn persist_snapshot(app_handle: &AppHandle, snapshot: &ShellStateSnapshot) -> Result<(), String> {
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
    })
}

#[tauri::command]
pub async fn load_shell_state_snapshot(
    app_handle: AppHandle,
    lock: tauri::State<'_, ShellStateStoreLock>,
    fallback: Value,
) -> Result<ShellStateSnapshot, String> {
    let _guard = lock.0.lock().await;
    let path = snapshot_path(&app_handle)?;
    with_cooperative_file_lock(&path, || load_snapshot(&app_handle, fallback))
}

#[tauri::command]
pub async fn compare_and_swap_shell_state(
    app_handle: AppHandle,
    lock: tauri::State<'_, ShellStateStoreLock>,
    request: ShellStateCompareAndSwapRequest,
) -> Result<ShellStateCompareAndSwapResponse, String> {
    let _guard = lock.0.lock().await;
    let path = snapshot_path(&app_handle)?;
    with_cooperative_file_lock(&path, || {
        let current = load_snapshot(&app_handle, Value::Null)?;
        let current_revision = current.revision;
        let current_state = current.state;

        if current_revision != request.expected_revision {
            return Ok(ShellStateCompareAndSwapResponse {
                committed: false,
                state: current_state,
                revision: current_revision,
            });
        }

        let next_revision = current_revision.saturating_add(1);
        let next_state = prepare_next_state(&current_state, request.state, next_revision);
        let snapshot = ShellStateSnapshot {
            state: next_state.clone(),
            revision: next_revision,
        };
        persist_snapshot(&app_handle, &snapshot)?;

        Ok(ShellStateCompareAndSwapResponse {
            committed: true,
            state: next_state,
            revision: next_revision,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{prepare_next_state, read_revision, TOMBSTONES_KEY};
    use serde_json::json;

    #[test]
    fn revisions_default_to_zero_and_accept_unsigned_numbers() {
        assert_eq!(read_revision(None), 0);
        assert_eq!(read_revision(Some(json!("invalid"))), 0);
        assert_eq!(read_revision(Some(json!(42))), 42);
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
}
