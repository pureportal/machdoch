use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

mod command_kinds;
#[cfg(test)]
mod command_tests;
mod commands;
mod dispatch;
mod fleet_gateway;
mod sanitize;
mod shell;
mod snapshot;
mod state;
mod state_progress;
mod state_store;

use commands::FleetCommandRecord;
pub use commands::FleetControlCommandEvent;
pub(crate) use fleet_gateway::handle_fleet_request;
pub use shell::FleetShellSnapshot;

const FLEET_CONTROL_COMMAND_EVENT: &str = "fleet-control-command";
const MAX_SESSIONS: usize = 128;
const MAX_LOG_ENTRIES: usize = 160;
const MAX_PROGRESS_LOG_BYTES: usize = 4 * 1024 * 1024;
const MAX_TIMELINE_ENTRIES: usize = 80;
const MAX_COMMAND_ENTRIES: usize = 100;
const MAX_PENDING_COMMAND_ENTRIES: usize = 256;
const MAX_COMPLETED_COMMAND_ENTRIES: usize = 512;
const MAX_COMMAND_TEXT_CHARS: usize = 8_000;
const MAX_FLEET_SHELL_SESSIONS: usize = 80;
const MAX_FLEET_SHELL_MESSAGES: usize = 80;
const MAX_FLEET_CONTEXT_PACKS: usize = 60;
const MAX_FLEET_PROMPT_HISTORY: usize = 30;
const MAX_FLEET_SCHEDULER_JOBS: usize = 80;
const MAX_FLEET_SCHEDULER_RUNS: usize = 120;
const MAX_FLEET_RALPH_FLOWS: usize = 160;
const MAX_FLEET_RALPH_RUNS: usize = 160;
const MAX_FLEET_RALPH_VARIABLES: usize = 64;
const MAX_FLEET_MEDIA_MODELS: usize = 128;
const MAX_FLEET_MEDIA_ASSETS: usize = 48;
const MAX_FLEET_MEDIA_RUNS: usize = 80;
const MAX_FLEET_MEDIA_PREVIEW_CHARS: usize = 120_000;
const MAX_FLEET_TEXT_CHARS: usize = 12_000;
const MAX_FLEET_SHORT_TEXT_CHARS: usize = 240;
const FLEET_CONTROL_STATE_SCHEMA_VERSION: u32 = 1;
const FLEET_CONTROL_STATE_FILE_NAME: &str = "fleet-control.json";

#[derive(Clone)]
pub struct FleetControlState {
    shared: Arc<FleetControlShared>,
}

struct FleetControlShared {
    inner: Mutex<FleetControlInner>,
}

#[derive(Default)]
struct FleetControlInner {
    event_id: u64,
    state_loaded: bool,
    sessions: HashMap<String, FleetTaskSession>,
    progress_log_bytes: usize,
    commands: VecDeque<FleetCommandRecord>,
    pending_commands: VecDeque<FleetControlCommandEvent>,
    completed_commands: VecDeque<CompletedFleetCommandReceipt>,
    shell: Option<FleetShellSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetControlStateFile {
    schema_version: u32,
    #[serde(default)]
    pending_commands: Vec<FleetControlCommandEvent>,
    #[serde(default)]
    completed_commands: Vec<CompletedFleetCommandReceipt>,
}

impl Default for FleetControlStateFile {
    fn default() -> Self {
        Self {
            schema_version: FLEET_CONTROL_STATE_SCHEMA_VERSION,
            pending_commands: Vec::new(),
            completed_commands: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletedFleetCommandReceipt {
    command_id: String,
    payload_hash: String,
    completed_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetTaskSession {
    task_id: String,
    task: String,
    mode: String,
    state: String,
    message: String,
    cancellable: bool,
    started_at: u64,
    updated_at: u64,
    progress_count: u64,
    logs: VecDeque<FleetLogEntry>,
    timeline: VecDeque<FleetTimelineEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FleetLogEntry {
    created_at: u64,
    stream: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
    chunk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FleetTimelineEntry {
    created_at: u64,
    kind: String,
    phase: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_name: Option<String>,
}

#[tauri::command]
pub async fn get_pending_fleet_control_commands(
    state: tauri::State<'_, FleetControlState>,
) -> Result<Vec<FleetControlCommandEvent>, String> {
    state.pending_commands()
}

#[tauri::command]
pub async fn acknowledge_fleet_control_command(
    state: tauri::State<'_, FleetControlState>,
    command_id: String,
) -> Result<bool, String> {
    state.acknowledge_command(&command_id)
}

#[tauri::command]
pub async fn update_fleet_control_shell_snapshot(
    state: tauri::State<'_, FleetControlState>,
    snapshot: FleetShellSnapshot,
) -> Result<(), String> {
    state.update_shell_snapshot(snapshot)
}

pub fn initialize(app_handle: &tauri::AppHandle) -> Result<(), String> {
    app_handle
        .state::<FleetControlState>()
        .ensure_state_loaded()
}

pub fn record_task_progress(
    app_handle: &tauri::AppHandle,
    task_id: &str,
    progress: &Value,
    timestamp: u64,
) {
    app_handle
        .state::<FleetControlState>()
        .record_progress(task_id, progress, timestamp);
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_string)
}

fn push_bounded<T>(items: &mut VecDeque<T>, item: T, max_items: usize) {
    while items.len() >= max_items {
        items.pop_front();
    }

    items.push_back(item);
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
