use std::{
    collections::{HashMap, VecDeque},
    sync::{atomic::AtomicBool, Arc, Condvar, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

mod auth;
mod command_kinds;
#[cfg(test)]
mod command_tests;
mod commands;
mod config;
mod mission_control_html;
mod mission_control_script_events;
mod mission_control_script_render;
mod pairing;
mod sanitize;
mod session;
mod shell;
mod state;
mod state_progress;
mod state_store;
mod status;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
mod web;

use commands::RemoteCommandRecord;
pub use commands::RemoteControlCommandEvent;
use pairing::open_url_in_system_browser;
pub use shell::RemoteShellSnapshot;
pub use status::RemoteControlStatus;

const REMOTE_CONTROL_COMMAND_EVENT: &str = "remote-control-command";
const MAX_SESSIONS: usize = 128;
const MAX_LOG_ENTRIES: usize = 160;
const MAX_TIMELINE_ENTRIES: usize = 80;
const MAX_COMMAND_ENTRIES: usize = 100;
const MAX_PAIRED_DEVICES: usize = 32;
const MAX_COMMAND_TEXT_CHARS: usize = 8_000;
const MAX_REMOTE_SHELL_SESSIONS: usize = 80;
const MAX_REMOTE_SHELL_MESSAGES: usize = 80;
const MAX_REMOTE_CONTEXT_PACKS: usize = 60;
const MAX_REMOTE_PROMPT_HISTORY: usize = 30;
const MAX_REMOTE_SCHEDULER_JOBS: usize = 80;
const MAX_REMOTE_SCHEDULER_RUNS: usize = 120;
const MAX_REMOTE_TEXT_CHARS: usize = 12_000;
const MAX_REMOTE_SHORT_TEXT_CHARS: usize = 240;
const DEFAULT_REMOTE_CONTROL_PORT: u16 = 43187;
const MIN_REMOTE_CONTROL_PORT: u16 = 1024;
const REMOTE_CONTROL_CONFIG_VERSION: u32 = 1;
const REMOTE_CONTROL_CONFIG_FILE_NAME: &str = "remote-control.json";
const WEB_SESSION_COOKIE_NAME: &str = "machdoch_mc";
const WEB_SESSION_TTL_MS: u64 = 365 * 24 * 60 * 60 * 1_000;
const SSE_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const SERVER_ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone)]
pub struct RemoteControlState {
    shared: Arc<RemoteControlShared>,
}

struct RemoteControlShared {
    inner: Mutex<RemoteControlInner>,
    updates: Condvar,
}

#[derive(Default)]
struct RemoteControlInner {
    event_id: u64,
    config_loaded: bool,
    config: RemoteControlConfigFile,
    server: Option<RemoteControlServerInfo>,
    sessions: HashMap<String, RemoteTaskSession>,
    commands: VecDeque<RemoteCommandRecord>,
    shell: Option<RemoteShellSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlConfigFile {
    #[serde(default = "config::default_remote_control_config_version")]
    version: u32,
    #[serde(default = "config::default_remote_control_port")]
    port: u16,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    paired_devices: Vec<RemoteControlPairedDevice>,
}

impl Default for RemoteControlConfigFile {
    fn default() -> Self {
        Self {
            version: REMOTE_CONTROL_CONFIG_VERSION,
            port: DEFAULT_REMOTE_CONTROL_PORT,
            enabled: false,
            paired_devices: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlPairedDevice {
    id: String,
    name: String,
    token_hash: String,
    created_at: u64,
    last_seen_at: u64,
    expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user_agent: Option<String>,
}

#[derive(Clone)]
struct RemoteControlServerInfo {
    token: String,
    port: u16,
    local_url: String,
    lan_url: Option<String>,
    display_url: String,
    qr_svg: String,
    started_at: u64,
    bind_address: String,
    shutdown: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTaskSession {
    task_id: String,
    task: String,
    mode: String,
    state: String,
    message: String,
    cancellable: bool,
    started_at: u64,
    updated_at: u64,
    progress_count: u64,
    logs: VecDeque<RemoteLogEntry>,
    timeline: VecDeque<RemoteTimelineEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteLogEntry {
    created_at: u64,
    stream: String,
    tool_name: Option<String>,
    chunk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTimelineEntry {
    created_at: u64,
    kind: String,
    phase: String,
    label: String,
    detail: Option<String>,
    tone: Option<String>,
    tool_name: Option<String>,
}

#[tauri::command]
pub async fn get_remote_control_status(
    state: tauri::State<'_, RemoteControlState>,
) -> Result<RemoteControlStatus, String> {
    state.status()
}

#[tauri::command]
pub async fn enable_remote_control_server(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, RemoteControlState>,
) -> Result<RemoteControlStatus, String> {
    state.enable(app_handle)
}

#[tauri::command]
pub async fn disable_remote_control_server(
    state: tauri::State<'_, RemoteControlState>,
) -> Result<RemoteControlStatus, String> {
    state.disable()
}

#[tauri::command]
pub async fn set_remote_control_port(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, RemoteControlState>,
    port: u16,
) -> Result<RemoteControlStatus, String> {
    state.set_port(app_handle, port)
}

#[tauri::command]
pub async fn update_remote_control_shell_snapshot(
    state: tauri::State<'_, RemoteControlState>,
    snapshot: RemoteShellSnapshot,
) -> Result<(), String> {
    state.update_shell_snapshot(snapshot)
}

#[tauri::command]
pub async fn forget_remote_control_pairings(
    state: tauri::State<'_, RemoteControlState>,
) -> Result<RemoteControlStatus, String> {
    state.forget_pairings()
}

#[tauri::command]
pub async fn open_remote_control_url(
    state: tauri::State<'_, RemoteControlState>,
) -> Result<(), String> {
    let display_url = state.display_url()?;
    open_url_in_system_browser(&display_url)
}

pub fn sync_remote_control_startup(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<RemoteControlState>();
    state.enable_if_configured(app_handle.clone())
}

pub fn record_task_progress(
    app_handle: &tauri::AppHandle,
    task_id: &str,
    progress: &Value,
    timestamp: u64,
) {
    let state = app_handle.state::<RemoteControlState>();
    state.record_progress(task_id, progress, timestamp);
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
