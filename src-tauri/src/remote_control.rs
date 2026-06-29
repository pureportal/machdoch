use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State as AxumState,
    http::{
        header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, REFERRER_POLICY},
        HeaderMap, HeaderValue, Method, StatusCode, Uri,
    },
    response::{
        sse::{Event, KeepAlive},
        Html, IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::net::TcpListener as TokioTcpListener;

use crate::desktop_task::{request_desktop_task_cancel, DesktopTaskCancelMap};

mod auth;
mod config;
mod http;
mod mission_control_html;
mod mission_control_script_events;
mod mission_control_script_render;
mod sanitize;
mod session;
mod shell;

#[cfg(test)]
use auth::constant_time_eq;
#[cfg(test)]
use auth::hash_remote_control_token;
use auth::{
    create_session_cookie, header_to_str, headers_are_authorized,
    headers_have_current_pairing_token, request_has_current_pairing_token, request_is_authorized,
    state_changing_headers_allowed, state_changing_request_is_allowed,
};
use config::{
    ensure_remote_control_port_available, load_remote_control_config_file,
    validate_remote_control_port, write_remote_control_config_file,
};
use http::{
    read_http_request, write_headers, write_html_response, write_json_response, HttpRequest,
};
use mission_control_html::mission_control_html;
use sanitize::sanitize_shell_snapshot;
use session::create_remote_web_session_token;
pub use shell::RemoteShellSnapshot;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
pub struct RemoteControlStatus {
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lan_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qr_svg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bind_address: Option<String>,
    port: u16,
    paired_device_count: usize,
    event_id: u64,
    sessions: Vec<RemoteTaskSession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlSnapshot {
    enabled: bool,
    server_time: u64,
    event_id: u64,
    sessions: Vec<RemoteTaskSession>,
    commands: Vec<RemoteCommandRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shell: Option<RemoteShellSnapshot>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlCommandEvent {
    command_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_pack_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommandRecord {
    command_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_preview: Option<String>,
    created_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommandRequest {
    kind: String,
    task_id: Option<String>,
    session_id: Option<String>,
    prompt: Option<String>,
    title: Option<String>,
    tags: Option<Vec<String>>,
    provider: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    workspace: Option<String>,
    enabled: Option<bool>,
    attachment_id: Option<String>,
    context_pack_id: Option<String>,
    message_id: Option<String>,
    job_id: Option<String>,
    run_id: Option<String>,
}

impl Default for RemoteControlState {
    fn default() -> Self {
        Self {
            shared: Arc::new(RemoteControlShared {
                inner: Mutex::new(RemoteControlInner::default()),
                updates: Condvar::new(),
            }),
        }
    }
}

impl RemoteControlState {
    fn status(&self) -> Result<RemoteControlStatus, String> {
        self.ensure_config_loaded()?;

        let inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect remote control state.".to_string())?;

        Ok(create_status_locked(&inner))
    }

    fn enable(&self, app_handle: tauri::AppHandle) -> Result<RemoteControlStatus, String> {
        self.ensure_config_loaded()?;

        {
            let inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| "Unable to inspect remote control state.".to_string())?;

            if inner.server.is_some() {
                return Ok(create_status_locked(&inner));
            }
        }

        let token = create_secure_token()?;
        let port = self.configured_port()?;
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
            .map_err(|error| format!("Unable to start Mission Control on port {port}: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Unable to configure Mission Control listener: {error}"))?;

        let port = listener
            .local_addr()
            .map_err(|error| format!("Unable to inspect Mission Control listener: {error}"))?
            .port();
        let local_url = format!("http://127.0.0.1:{port}/#pair={token}");
        let lan_url = detect_lan_ip().map(|ip| format!("http://{ip}:{port}/#pair={token}"));
        let display_url = lan_url.clone().unwrap_or_else(|| local_url.clone());
        let qr_svg = create_qr_svg(&display_url)?;
        let started_at = now_millis();
        let shutdown = Arc::new(AtomicBool::new(false));
        let bind_address = format!("0.0.0.0:{port}");

        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| "Unable to update remote control state.".to_string())?;

            if inner.server.is_some() {
                if !inner.config.enabled {
                    inner.config.enabled = true;
                    inner.config.version = REMOTE_CONTROL_CONFIG_VERSION;
                    write_remote_control_config_file(&inner.config)?;
                }
                return Ok(create_status_locked(&inner));
            }

            inner.config.enabled = true;
            inner.config.version = REMOTE_CONTROL_CONFIG_VERSION;
            write_remote_control_config_file(&inner.config)?;
            inner.server = Some(RemoteControlServerInfo {
                token: token.clone(),
                port,
                local_url,
                lan_url,
                display_url,
                qr_svg,
                started_at,
                bind_address,
                shutdown: shutdown.clone(),
            });
            inner.event_id = inner.event_id.saturating_add(1);
            self.shared.updates.notify_all();
        }

        let shared = self.shared.clone();
        tauri::async_runtime::spawn(async move {
            run_http_server(listener, shared, app_handle, shutdown).await;
        });

        self.status()
    }

    fn disable(&self) -> Result<RemoteControlStatus, String> {
        self.ensure_config_loaded()?;

        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to update remote control state.".to_string())?;

        let mut changed = false;

        if let Some(server) = inner.server.take() {
            server.shutdown.store(true, Ordering::SeqCst);
            changed = true;
        }

        if inner.config.enabled {
            inner.config.enabled = false;
            inner.config.version = REMOTE_CONTROL_CONFIG_VERSION;
            write_remote_control_config_file(&inner.config)?;
            changed = true;
        }

        if changed {
            inner.event_id = inner.event_id.saturating_add(1);
            self.shared.updates.notify_all();
        }

        Ok(create_status_locked(&inner))
    }

    fn record_progress(&self, task_id: &str, progress: &Value, timestamp: u64) {
        let normalized_task_id = task_id.trim();

        if normalized_task_id.is_empty() {
            return;
        }

        let Ok(mut inner) = self.shared.inner.lock() else {
            return;
        };

        if inner.sessions.len() >= MAX_SESSIONS && !inner.sessions.contains_key(normalized_task_id)
        {
            if let Some(stale_task_id) = inner
                .sessions
                .values()
                .min_by_key(|session| session.updated_at)
                .map(|session| session.task_id.clone())
            {
                inner.sessions.remove(&stale_task_id);
            }
        }

        let session = inner
            .sessions
            .entry(normalized_task_id.to_string())
            .or_insert_with(|| RemoteTaskSession {
                task_id: normalized_task_id.to_string(),
                task: normalized_task_id.to_string(),
                mode: "machdoch".to_string(),
                state: "starting".to_string(),
                message: "Task started.".to_string(),
                cancellable: true,
                started_at: timestamp,
                updated_at: timestamp,
                progress_count: 0,
                logs: VecDeque::new(),
                timeline: VecDeque::new(),
            });

        session.progress_count = session.progress_count.saturating_add(1);
        session.updated_at = timestamp;

        if let Some(task) = string_field(progress, "task").filter(|value| !value.is_empty()) {
            session.task = task;
        }

        if let Some(mode) = string_field(progress, "mode").filter(|value| !value.is_empty()) {
            session.mode = mode;
        }

        if let Some(state) = string_field(progress, "state").filter(|value| !value.is_empty()) {
            session.state = state;
        }

        if let Some(message) = string_field(progress, "message") {
            session.message = message;
        }

        if let Some(cancellable) = progress.get("cancellable").and_then(Value::as_bool) {
            session.cancellable = cancellable;
        }

        if let Some(action_output) = progress.get("actionOutput").and_then(Value::as_object) {
            if let Some(chunk) = action_output.get("chunk").and_then(Value::as_str) {
                if !chunk.is_empty() {
                    push_bounded(
                        &mut session.logs,
                        RemoteLogEntry {
                            created_at: timestamp,
                            stream: action_output
                                .get("stream")
                                .and_then(Value::as_str)
                                .unwrap_or("stdout")
                                .to_string(),
                            tool_name: action_output
                                .get("toolName")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            chunk: truncate_chars(chunk, MAX_COMMAND_TEXT_CHARS),
                        },
                        MAX_LOG_ENTRIES,
                    );
                }
            }
        }

        if let Some(timeline_event) = progress.get("timelineEvent").and_then(Value::as_object) {
            if let (Some(kind), Some(phase), Some(label)) = (
                timeline_event.get("kind").and_then(Value::as_str),
                timeline_event.get("phase").and_then(Value::as_str),
                timeline_event.get("label").and_then(Value::as_str),
            ) {
                push_bounded(
                    &mut session.timeline,
                    RemoteTimelineEntry {
                        created_at: timestamp,
                        kind: kind.to_string(),
                        phase: phase.to_string(),
                        label: label.to_string(),
                        detail: timeline_event
                            .get("detail")
                            .and_then(Value::as_str)
                            .map(|value| truncate_chars(value, 1_000)),
                        tone: timeline_event
                            .get("tone")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        tool_name: timeline_event
                            .get("toolName")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    },
                    MAX_TIMELINE_ENTRIES,
                );
            }
        }

        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.updates.notify_all();
    }

    fn record_command(&self, event: &RemoteControlCommandEvent) {
        let Ok(mut inner) = self.shared.inner.lock() else {
            return;
        };

        push_bounded(
            &mut inner.commands,
            RemoteCommandRecord {
                command_id: event.command_id.clone(),
                kind: event.kind.clone(),
                task_id: event.task_id.clone(),
                session_id: event.session_id.clone(),
                prompt_preview: event
                    .prompt
                    .as_deref()
                    .map(|value| truncate_chars(value, 240)),
                title: event.title.clone(),
                target_preview: create_command_target_preview(event),
                created_at: event.created_at,
            },
            MAX_COMMAND_ENTRIES,
        );
        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.updates.notify_all();
    }

    fn update_shell_snapshot(&self, snapshot: RemoteShellSnapshot) -> Result<(), String> {
        self.ensure_config_loaded()?;

        let snapshot = sanitize_shell_snapshot(snapshot)?;
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to update Mission Control shell snapshot.".to_string())?;

        inner.shell = Some(snapshot);
        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.updates.notify_all();

        Ok(())
    }

    fn create_web_session(&self, user_agent: Option<&str>) -> Result<String, String> {
        self.ensure_config_loaded()?;

        create_remote_web_session_token(&self.shared, user_agent)
    }

    fn display_url(&self) -> Result<String, String> {
        let inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect Mission Control state.".to_string())?;

        inner
            .server
            .as_ref()
            .map(|server| server.display_url.clone())
            .ok_or_else(|| "Mission Control is not running.".to_string())
    }

    fn set_port(
        &self,
        app_handle: tauri::AppHandle,
        port: u16,
    ) -> Result<RemoteControlStatus, String> {
        let port = validate_remote_control_port(port)?;
        self.ensure_config_loaded()?;
        let current_port = self.configured_port()?;

        if current_port != port {
            ensure_remote_control_port_available(port)?;
        }

        let should_restart = {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| "Unable to update Mission Control port.".to_string())?;

            if inner.config.port == port {
                return Ok(create_status_locked(&inner));
            }

            inner.config.port = port;
            inner.config.version = REMOTE_CONTROL_CONFIG_VERSION;
            write_remote_control_config_file(&inner.config)?;

            let should_restart = if let Some(server) = inner.server.take() {
                server.shutdown.store(true, Ordering::SeqCst);
                true
            } else {
                inner.config.enabled
            };

            inner.event_id = inner.event_id.saturating_add(1);
            self.shared.updates.notify_all();
            should_restart
        };

        if should_restart {
            self.enable(app_handle)
        } else {
            self.status()
        }
    }

    fn forget_pairings(&self) -> Result<RemoteControlStatus, String> {
        self.ensure_config_loaded()?;

        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to revoke Mission Control pairings.".to_string())?;

        if inner.config.paired_devices.is_empty() {
            return Ok(create_status_locked(&inner));
        }

        inner.config.paired_devices.clear();
        inner.config.version = REMOTE_CONTROL_CONFIG_VERSION;
        write_remote_control_config_file(&inner.config)?;
        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.updates.notify_all();

        Ok(create_status_locked(&inner))
    }

    fn ensure_config_loaded(&self) -> Result<(), String> {
        let already_loaded = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect Mission Control settings.".to_string())?
            .config_loaded;

        if already_loaded {
            return Ok(());
        }

        let config = load_remote_control_config_file()?;
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to load Mission Control settings.".to_string())?;

        if !inner.config_loaded {
            inner.config = config;
            inner.config_loaded = true;
        }

        Ok(())
    }

    fn configured_port(&self) -> Result<u16, String> {
        let inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect Mission Control settings.".to_string())?;

        validate_remote_control_port(inner.config.port)
    }

    fn enable_if_configured(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        self.ensure_config_loaded()?;

        let should_enable = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect Mission Control startup settings.".to_string())?
            .config
            .enabled;

        if should_enable {
            self.enable(app_handle)?;
        }

        Ok(())
    }
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

#[derive(Clone)]
struct RemoteWebServerState {
    shared: Arc<RemoteControlShared>,
    app_handle: tauri::AppHandle,
    shutdown: Arc<AtomicBool>,
}

async fn run_http_server(
    listener: TcpListener,
    shared: Arc<RemoteControlShared>,
    app_handle: tauri::AppHandle,
    shutdown: Arc<AtomicBool>,
) {
    let listener = match TokioTcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Unable to create Mission Control web listener: {error}");
            shutdown.store(true, Ordering::SeqCst);
            return;
        }
    };
    let state = RemoteWebServerState {
        shared,
        app_handle,
        shutdown: shutdown.clone(),
    };
    let app = Router::new()
        .route("/", get(serve_mission_control_html))
        .route("/api/session", post(create_remote_web_session))
        .route("/api/status", get(get_remote_web_status))
        .route("/api/events", get(stream_remote_web_events))
        .route("/api/command", post(post_remote_web_command))
        .fallback(remote_web_not_found)
        .with_state(state);

    if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(wait_for_remote_web_shutdown(shutdown))
        .await
    {
        eprintln!("Mission Control web server stopped unexpectedly: {error}");
    }
}

async fn wait_for_remote_web_shutdown(shutdown: Arc<AtomicBool>) {
    while !shutdown.load(Ordering::SeqCst) {
        tokio::time::sleep(SERVER_ACCEPT_POLL_INTERVAL).await;
    }
}

async fn serve_mission_control_html() -> Response {
    let mut response = Html(mission_control_html()).into_response();
    add_secure_html_headers(response.headers_mut());
    response
}

async fn create_remote_web_session(
    AxumState(state): AxumState<RemoteWebServerState>,
    headers: HeaderMap,
) -> Response {
    if !headers_have_current_pairing_token(&headers, &state.shared) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Mission Control pairing token is missing or invalid." }),
        );
    }

    if !state_changing_headers_allowed(&headers) {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "Cross-origin Mission Control session rejected." }),
        );
    }

    let control_state = RemoteControlState {
        shared: state.shared.clone(),
    };
    let user_agent = header_to_str(&headers, "user-agent");

    match control_state.create_web_session(user_agent) {
        Ok(session_token) => {
            let mut response = json_response(StatusCode::OK, json!({ "ok": true }));
            match HeaderValue::from_str(&create_session_cookie(&session_token)) {
                Ok(cookie) => {
                    response.headers_mut().insert("Set-Cookie", cookie);
                    response
                }
                Err(_) => json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "Unable to create Mission Control web session cookie." }),
                ),
            }
        }
        Err(error) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": error })),
    }
}

async fn get_remote_web_status(
    AxumState(state): AxumState<RemoteWebServerState>,
    headers: HeaderMap,
) -> Response {
    if !headers_are_authorized(&headers, &state.shared) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Mission Control token is missing or invalid." }),
        );
    }

    let snapshot = {
        let Ok(inner) = state.shared.inner.lock() else {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Mission Control state is unavailable." }),
            );
        };
        create_snapshot_locked(&inner)
    };

    json_response(StatusCode::OK, json!(snapshot))
}

async fn stream_remote_web_events(
    AxumState(state): AxumState<RemoteWebServerState>,
    headers: HeaderMap,
) -> Response {
    if !headers_are_authorized(&headers, &state.shared) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Mission Control token is missing or invalid." }),
        );
    }

    let shared = state.shared.clone();
    let shutdown = state.shutdown.clone();
    let stream = async_stream::stream! {
        let mut last_event_id = 0;

        while !shutdown.load(Ordering::SeqCst) {
            let snapshot = {
                let Ok(inner) = shared.inner.lock() else {
                    break;
                };
                create_snapshot_locked(&inner)
            };

            if snapshot.event_id != last_event_id {
                last_event_id = snapshot.event_id;

                if let Ok(payload) = serde_json::to_string(&snapshot) {
                    yield Ok::<Event, Infallible>(
                        Event::default()
                            .event("snapshot")
                            .id(snapshot.event_id.to_string())
                            .data(payload),
                    );
                }
            }

            tokio::time::sleep(Duration::from_millis(750)).await;
        }
    };

    let mut response = Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(SSE_KEEPALIVE_INTERVAL)
                .text("keep-alive"),
        )
        .into_response();
    add_no_store_header(response.headers_mut());
    response
}

async fn post_remote_web_command(
    AxumState(state): AxumState<RemoteWebServerState>,
    headers: HeaderMap,
    Json(parsed): Json<RemoteCommandRequest>,
) -> Response {
    if !headers_are_authorized(&headers, &state.shared) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Mission Control token is missing or invalid." }),
        );
    }

    if !state_changing_headers_allowed(&headers) {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "Cross-origin Mission Control command rejected." }),
        );
    }

    let event = match normalize_command(parsed) {
        Ok(event) => event,
        Err(error) => return json_response(StatusCode::BAD_REQUEST, json!({ "error": error })),
    };

    let control_state = RemoteControlState {
        shared: state.shared.clone(),
    };
    control_state.record_command(&event);

    if event.kind == "cancel" {
        if let Some(task_id) = event.task_id.as_deref() {
            let cancel_state = state.app_handle.state::<DesktopTaskCancelMap>();
            request_desktop_task_cancel(&cancel_state, task_id);
        }
    }

    let _ = state
        .app_handle
        .emit(REMOTE_CONTROL_COMMAND_EVENT, event.clone());

    json_response(
        StatusCode::ACCEPTED,
        json!({
            "ok": true,
            "commandId": event.command_id,
        }),
    )
}

async fn remote_web_not_found(method: Method, uri: Uri) -> Response {
    json_response(
        StatusCode::NOT_FOUND,
        json!({
            "error": "Mission Control endpoint not found.",
            "method": method.as_str(),
            "path": uri.path(),
        }),
    )
}

fn json_response(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    add_no_store_header(response.headers_mut());
    response
}

fn add_no_store_header(headers: &mut HeaderMap) {
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
}

fn add_secure_html_headers(headers: &mut HeaderMap) {
    add_no_store_header(headers);
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
}

#[allow(dead_code)]
fn handle_connection(
    mut stream: TcpStream,
    shared: Arc<RemoteControlShared>,
    app_handle: tauri::AppHandle,
    shutdown: Arc<AtomicBool>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(20)));

    let request = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_json_response(&mut stream, 400, json!({ "error": error }), &[]);
            return;
        }
    };

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => {
            let _ = write_html_response(&mut stream, mission_control_html());
        }
        ("POST", "/api/session") => {
            if !request_has_current_pairing_token(&request, &shared) {
                let _ = write_json_response(
                    &mut stream,
                    401,
                    json!({ "error": "Mission Control pairing token is missing or invalid." }),
                    &[],
                );
                return;
            }

            if !state_changing_request_is_allowed(&request) {
                let _ = write_json_response(
                    &mut stream,
                    403,
                    json!({ "error": "Cross-origin Mission Control session rejected." }),
                    &[],
                );
                return;
            }

            let state = RemoteControlState {
                shared: shared.clone(),
            };

            let user_agent = request.headers.get("user-agent").map(String::as_str);
            match state.create_web_session(user_agent) {
                Ok(session_token) => {
                    let cookie = create_session_cookie(&session_token);
                    let _ = write_json_response(
                        &mut stream,
                        200,
                        json!({ "ok": true }),
                        &[("Set-Cookie", cookie.as_str())],
                    );
                }
                Err(error) => {
                    let _ = write_json_response(&mut stream, 500, json!({ "error": error }), &[]);
                }
            }
        }
        ("GET", "/api/status") => {
            if !request_is_authorized(&request, &shared) {
                let _ = write_json_response(
                    &mut stream,
                    401,
                    json!({ "error": "Mission Control token is missing or invalid." }),
                    &[],
                );
                return;
            }

            let snapshot = {
                let Ok(inner) = shared.inner.lock() else {
                    let _ = write_json_response(
                        &mut stream,
                        500,
                        json!({ "error": "Mission Control state is unavailable." }),
                        &[],
                    );
                    return;
                };
                create_snapshot_locked(&inner)
            };
            let _ = write_json_response(&mut stream, 200, json!(snapshot), &[]);
        }
        ("GET", "/api/events") => {
            if !request_is_authorized(&request, &shared) {
                let _ = write_json_response(
                    &mut stream,
                    401,
                    json!({ "error": "Mission Control token is missing or invalid." }),
                    &[],
                );
                return;
            }

            handle_sse_stream(stream, shared, shutdown);
        }
        ("POST", "/api/command") => {
            if !request_is_authorized(&request, &shared) {
                let _ = write_json_response(
                    &mut stream,
                    401,
                    json!({ "error": "Mission Control token is missing or invalid." }),
                    &[],
                );
                return;
            }

            if !state_changing_request_is_allowed(&request) {
                let _ = write_json_response(
                    &mut stream,
                    403,
                    json!({ "error": "Cross-origin Mission Control command rejected." }),
                    &[],
                );
                return;
            }

            handle_command_request(stream, request, shared, app_handle);
        }
        _ => {
            let _ = write_json_response(
                &mut stream,
                404,
                json!({ "error": "Mission Control endpoint not found." }),
                &[],
            );
        }
    }
}

#[allow(dead_code)]
fn handle_sse_stream(
    mut stream: TcpStream,
    shared: Arc<RemoteControlShared>,
    shutdown: Arc<AtomicBool>,
) {
    let headers = [
        ("Content-Type", "text/event-stream; charset=utf-8"),
        ("Cache-Control", "no-cache, no-store, must-revalidate"),
        ("Connection", "keep-alive"),
        ("X-Accel-Buffering", "no"),
    ];

    if write_headers(&mut stream, 200, &headers, None).is_err() {
        return;
    }

    let mut last_event_id = 0;

    while !shutdown.load(Ordering::SeqCst) {
        let snapshot = {
            let Ok(mut inner) = shared.inner.lock() else {
                break;
            };

            if inner.event_id == last_event_id {
                let wait_result = shared
                    .updates
                    .wait_timeout(inner, SSE_KEEPALIVE_INTERVAL)
                    .map_err(|_| ());

                match wait_result {
                    Ok((next_inner, _)) => {
                        inner = next_inner;
                    }
                    Err(_) => break,
                }
            }

            create_snapshot_locked(&inner)
        };

        if snapshot.event_id == last_event_id {
            if stream.write_all(b": keep-alive\n\n").is_err() {
                break;
            }
            continue;
        }

        last_event_id = snapshot.event_id;
        let Ok(payload) = serde_json::to_string(&snapshot) else {
            break;
        };
        let frame = format!(
            "event: snapshot\nid: {}\ndata: {}\n\n",
            snapshot.event_id, payload
        );

        if stream.write_all(frame.as_bytes()).is_err() {
            break;
        }
    }
}

#[allow(dead_code)]
fn handle_command_request(
    mut stream: TcpStream,
    request: HttpRequest,
    shared: Arc<RemoteControlShared>,
    app_handle: tauri::AppHandle,
) {
    let parsed = match serde_json::from_slice::<RemoteCommandRequest>(&request.body) {
        Ok(parsed) => parsed,
        Err(error) => {
            let _ = write_json_response(
                &mut stream,
                400,
                json!({ "error": format!("Invalid Mission Control command JSON: {error}") }),
                &[],
            );
            return;
        }
    };

    let event = match normalize_command(parsed) {
        Ok(event) => event,
        Err(error) => {
            let _ = write_json_response(&mut stream, 400, json!({ "error": error }), &[]);
            return;
        }
    };

    let state = RemoteControlState { shared };
    state.record_command(&event);

    if event.kind == "cancel" {
        if let Some(task_id) = event.task_id.as_deref() {
            let cancel_state = app_handle.state::<DesktopTaskCancelMap>();
            request_desktop_task_cancel(&cancel_state, task_id);
        }
    }

    let _ = app_handle.emit(REMOTE_CONTROL_COMMAND_EVENT, event.clone());
    let _ = write_json_response(
        &mut stream,
        202,
        json!({
            "ok": true,
            "commandId": event.command_id,
        }),
        &[],
    );
}

fn normalize_command(request: RemoteCommandRequest) -> Result<RemoteControlCommandEvent, String> {
    let kind = request.kind.trim().to_ascii_lowercase();
    let allowed = matches!(
        kind.as_str(),
        "cancel"
            | "retry"
            | "continue"
            | "follow-up"
            | "create-session"
            | "activate-session"
            | "archive-session"
            | "pin-session"
            | "duplicate-session"
            | "branch-session"
            | "delete-session"
            | "rename-session"
            | "tag-session"
            | "clear-session-history"
            | "update-draft"
            | "set-session-model"
            | "set-session-mode"
            | "set-session-memory"
            | "set-global-memory"
            | "set-ui-control"
            | "remove-attachment"
            | "clear-attachments"
            | "apply-context-pack"
            | "delete-context-pack"
            | "save-message-context-pack"
            | "speak-message"
            | "stop-speaking"
            | "scheduler-trigger"
            | "scheduler-pause"
            | "scheduler-resume"
            | "scheduler-delete"
            | "scheduler-retry-run"
            | "scheduler-cancel-run"
    );

    if !allowed {
        return Err("Unsupported Mission Control command.".to_string());
    }

    let task_id = request
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let session_id = request
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if matches!(kind.as_str(), "cancel" | "retry" | "continue") && task_id.is_none() {
        return Err("This Mission Control command requires a taskId.".to_string());
    }

    if matches!(
        kind.as_str(),
        "activate-session"
            | "archive-session"
            | "pin-session"
            | "duplicate-session"
            | "branch-session"
            | "delete-session"
            | "rename-session"
            | "tag-session"
            | "clear-session-history"
            | "update-draft"
            | "set-session-model"
            | "set-session-mode"
            | "set-session-memory"
            | "set-global-memory"
            | "set-ui-control"
            | "remove-attachment"
            | "clear-attachments"
            | "apply-context-pack"
            | "save-message-context-pack"
            | "speak-message"
    ) && session_id.is_none()
    {
        return Err("This Mission Control command requires a sessionId.".to_string());
    }

    let prompt = request
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_COMMAND_TEXT_CHARS));

    if kind == "follow-up" && prompt.is_none() {
        return Err("Queued follow-up commands require a prompt.".to_string());
    }

    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_REMOTE_SHORT_TEXT_CHARS));

    if kind == "rename-session" && title.is_none() {
        return Err("Renaming a session requires a title.".to_string());
    }

    let tags = request.tags.map(|tags| {
        tags.into_iter()
            .map(|tag| truncate_chars(tag.trim(), 64))
            .filter(|tag| !tag.is_empty())
            .take(24)
            .collect::<Vec<_>>()
    });

    if kind == "tag-session" && tags.is_none() {
        return Err("Tagging a session requires tags.".to_string());
    }

    let provider = request
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_REMOTE_SHORT_TEXT_CHARS));
    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_REMOTE_SHORT_TEXT_CHARS));

    if kind == "set-session-model" && (provider.is_none() || model.is_none()) {
        return Err("Model selection requires provider and model.".to_string());
    }

    let mode = request
        .mode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_REMOTE_SHORT_TEXT_CHARS));
    if kind == "set-session-mode" && !matches!(mode.as_deref(), Some("ask" | "machdoch")) {
        return Err("Session mode must be ask or machdoch.".to_string());
    }
    let workspace = request
        .workspace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_REMOTE_TEXT_CHARS));

    if matches!(
        kind.as_str(),
        "set-session-memory" | "set-global-memory" | "set-ui-control"
    ) && request.enabled.is_none()
    {
        return Err("This Mission Control command requires an enabled value.".to_string());
    }

    let attachment_id = request
        .attachment_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if kind == "remove-attachment" && attachment_id.is_none() {
        return Err("Removing an attachment requires an attachmentId.".to_string());
    }

    let context_pack_id = request
        .context_pack_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if matches!(kind.as_str(), "apply-context-pack" | "delete-context-pack")
        && context_pack_id.is_none()
    {
        return Err("This Mission Control command requires a contextPackId.".to_string());
    }

    let message_id = request
        .message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if matches!(kind.as_str(), "save-message-context-pack" | "speak-message")
        && message_id.is_none()
    {
        return Err("This Mission Control command requires a messageId.".to_string());
    }

    let job_id = request
        .job_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if matches!(
        kind.as_str(),
        "scheduler-trigger" | "scheduler-pause" | "scheduler-resume" | "scheduler-delete"
    ) && job_id.is_none()
    {
        return Err("This Mission Control command requires a jobId.".to_string());
    }

    let run_id = request
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if matches!(
        kind.as_str(),
        "scheduler-retry-run" | "scheduler-cancel-run"
    ) && run_id.is_none()
    {
        return Err("This Mission Control command requires a runId.".to_string());
    }

    Ok(RemoteControlCommandEvent {
        command_id: create_command_id(),
        kind,
        task_id,
        session_id,
        prompt,
        title,
        tags,
        provider,
        model,
        mode,
        workspace,
        enabled: request.enabled,
        attachment_id,
        context_pack_id,
        message_id,
        job_id,
        run_id,
        created_at: now_millis(),
    })
}

fn refresh_server_pairing_url(
    server: &mut RemoteControlServerInfo,
    token: String,
) -> Result<(), String> {
    let port = server.port;
    let local_url = format!("http://127.0.0.1:{port}/#pair={token}");
    let lan_url = detect_lan_ip().map(|ip| format!("http://{ip}:{port}/#pair={token}"));
    let display_url = lan_url.clone().unwrap_or_else(|| local_url.clone());
    let qr_svg = create_qr_svg(&display_url)?;

    server.token = token;
    server.local_url = local_url;
    server.lan_url = lan_url;
    server.display_url = display_url;
    server.qr_svg = qr_svg;

    Ok(())
}

fn open_url_in_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(url)
            .creation_flags(CREATE_NO_WINDOW);

        return command.spawn().map(|_| ()).map_err(|error| {
            format!("Mission Control could not be opened in your browser: {error}")
        });
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(url);

        return command.spawn().map(|_| ()).map_err(|error| {
            format!("Mission Control could not be opened in your browser: {error}")
        });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(url);

        return command.spawn().map(|_| ()).map_err(|error| {
            format!("Mission Control could not be opened in your browser: {error}")
        });
    }

    #[allow(unreachable_code)]
    Err("Opening Mission Control is not supported on this platform.".to_string())
}

fn create_status_locked(inner: &RemoteControlInner) -> RemoteControlStatus {
    let sessions = sorted_sessions(inner);

    match &inner.server {
        Some(server) => RemoteControlStatus {
            enabled: true,
            local_url: Some(server.local_url.clone()),
            lan_url: server.lan_url.clone(),
            display_url: Some(server.display_url.clone()),
            qr_svg: Some(server.qr_svg.clone()),
            token_hint: Some(create_token_hint(&server.token)),
            started_at: Some(server.started_at),
            bind_address: Some(server.bind_address.clone()),
            port: inner.config.port,
            paired_device_count: inner.config.paired_devices.len(),
            event_id: inner.event_id,
            sessions,
        },
        None => RemoteControlStatus {
            enabled: false,
            local_url: None,
            lan_url: None,
            display_url: None,
            qr_svg: None,
            token_hint: None,
            started_at: None,
            bind_address: None,
            port: inner.config.port,
            paired_device_count: inner.config.paired_devices.len(),
            event_id: inner.event_id,
            sessions,
        },
    }
}

fn create_snapshot_locked(inner: &RemoteControlInner) -> RemoteControlSnapshot {
    RemoteControlSnapshot {
        enabled: inner.server.is_some(),
        server_time: now_millis(),
        event_id: inner.event_id,
        sessions: sorted_sessions(inner),
        commands: inner.commands.iter().cloned().rev().collect(),
        shell: inner.shell.clone(),
    }
}

fn sorted_sessions(inner: &RemoteControlInner) -> Vec<RemoteTaskSession> {
    let mut sessions = inner.sessions.values().cloned().collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions
}

fn create_command_target_preview(event: &RemoteControlCommandEvent) -> Option<String> {
    [
        event
            .session_id
            .as_deref()
            .map(|value| format!("session:{value}")),
        event
            .task_id
            .as_deref()
            .map(|value| format!("task:{value}")),
        event.job_id.as_deref().map(|value| format!("job:{value}")),
        event.run_id.as_deref().map(|value| format!("run:{value}")),
        event
            .message_id
            .as_deref()
            .map(|value| format!("message:{value}")),
        event
            .context_pack_id
            .as_deref()
            .map(|value| format!("context-pack:{value}")),
        event
            .attachment_id
            .as_deref()
            .map(|value| format!("attachment:{value}")),
    ]
    .into_iter()
    .flatten()
    .next()
    .map(|value| truncate_chars(&value, MAX_REMOTE_SHORT_TEXT_CHARS))
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

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    value.chars().take(max_chars).collect::<String>()
}

fn create_token_hint(token: &str) -> String {
    let suffix = token
        .chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();

    format!("...{suffix}")
}

fn create_secure_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Unable to create a secure Mission Control token: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn create_command_id() -> String {
    let mut bytes = [0_u8; 12];

    if getrandom::fill(&mut bytes).is_ok() {
        return URL_SAFE_NO_PAD.encode(bytes);
    }

    format!("cmd-{}", now_millis())
}

fn create_qr_svg(url: &str) -> Result<String, String> {
    let code = QrCode::new(url.as_bytes())
        .map_err(|error| format!("Unable to create Mission Control QR code: {error}"))?;

    Ok(code
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .dark_color(svg::Color("#0f172a"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

fn detect_lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))).ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();

    if ip.is_loopback() {
        return None;
    }

    Some(ip)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::{
        constant_time_eq, create_snapshot_locked, create_status_locked, hash_remote_control_token,
        normalize_command, now_millis, request_is_authorized, state_changing_request_is_allowed,
        HttpRequest, RemoteCommandRequest, RemoteControlInner, RemoteControlPairedDevice,
        RemoteControlState, WEB_SESSION_COOKIE_NAME, WEB_SESSION_TTL_MS,
    };

    fn command_request(kind: &str) -> RemoteCommandRequest {
        RemoteCommandRequest {
            kind: kind.to_string(),
            task_id: None,
            session_id: None,
            prompt: None,
            title: None,
            tags: None,
            provider: None,
            model: None,
            mode: None,
            workspace: None,
            enabled: None,
            attachment_id: None,
            context_pack_id: None,
            message_id: None,
            job_id: None,
            run_id: None,
        }
    }

    #[test]
    fn token_comparison_requires_same_bytes_and_length() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
        assert!(!constant_time_eq(b"abc123", b"abc124"));
        assert!(!constant_time_eq(b"abc123", b"abc1234"));
    }

    #[test]
    fn follow_up_commands_require_prompt_text() {
        let result = normalize_command(RemoteCommandRequest {
            kind: "follow-up".to_string(),
            task_id: Some("task-1".to_string()),
            session_id: None,
            prompt: Some("   ".to_string()),
            ..command_request("follow-up")
        });

        assert!(result.is_err());
    }

    #[test]
    fn api_authorization_requires_paired_session_cookie() {
        let state = RemoteControlState::default();
        let session_token = "browser-session-token";
        {
            let mut inner = state.shared.inner.lock().expect("state lock");
            inner.config_loaded = true;
            inner.config.paired_devices.push(RemoteControlPairedDevice {
                id: "device-1".to_string(),
                name: "Test browser".to_string(),
                token_hash: hash_remote_control_token(session_token),
                created_at: 1,
                last_seen_at: 1,
                expires_at: now_millis().saturating_add(WEB_SESSION_TTL_MS),
                user_agent: None,
            });
        }
        let bearer_request = HttpRequest {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            headers: HashMap::from([(
                "authorization".to_string(),
                "Bearer control-token".to_string(),
            )]),
            body: Vec::new(),
        };
        let cookie_request = HttpRequest {
            method: "GET".to_string(),
            path: "/api/status".to_string(),
            headers: HashMap::from([(
                "cookie".to_string(),
                format!("{WEB_SESSION_COOKIE_NAME}={session_token}"),
            )]),
            body: Vec::new(),
        };
        let query_request = HttpRequest {
            method: "GET".to_string(),
            path: "/api/status?token=control-token".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        };

        assert!(!request_is_authorized(&bearer_request, &state.shared));
        assert!(request_is_authorized(&cookie_request, &state.shared));
        assert!(!request_is_authorized(&query_request, &state.shared));
    }

    #[test]
    fn state_changing_requests_require_custom_remote_header() {
        let missing_header = HttpRequest {
            method: "POST".to_string(),
            path: "/api/command".to_string(),
            headers: HashMap::new(),
            body: Vec::new(),
        };
        let same_origin = HttpRequest {
            method: "POST".to_string(),
            path: "/api/command".to_string(),
            headers: HashMap::from([
                ("x-machdoch-remote".to_string(), "1".to_string()),
                ("origin".to_string(), "http://127.0.0.1:5000".to_string()),
                ("host".to_string(), "127.0.0.1:5000".to_string()),
            ]),
            body: Vec::new(),
        };

        assert!(!state_changing_request_is_allowed(&missing_header));
        assert!(state_changing_request_is_allowed(&same_origin));
    }

    #[test]
    fn approval_decision_commands_are_not_supported() {
        let result = normalize_command(RemoteCommandRequest {
            kind: "approval-decision".to_string(),
            task_id: Some("task-1".to_string()),
            session_id: None,
            prompt: None,
            ..command_request("approval-decision")
        });

        assert!(result.is_err());
    }

    #[test]
    fn set_session_mode_accepts_only_supported_modes() {
        let invalid = normalize_command(RemoteCommandRequest {
            kind: "set-session-mode".to_string(),
            session_id: Some("session-1".to_string()),
            mode: Some("auto".to_string()),
            ..command_request("set-session-mode")
        });

        assert!(invalid
            .expect_err("invalid session mode should be rejected")
            .contains("ask or machdoch"));

        let allowed = normalize_command(RemoteCommandRequest {
            kind: "set-session-mode".to_string(),
            session_id: Some("session-1".to_string()),
            mode: Some("ask".to_string()),
            ..command_request("set-session-mode")
        })
        .expect("supported session mode should normalize");

        assert_eq!(allowed.mode.as_deref(), Some("ask"));
    }

    #[test]
    fn recorded_progress_updates_remote_snapshot() {
        let state = RemoteControlState::default();

        state.record_progress(
            "task-1",
            &json!({
                "task": "Build the app",
                "mode": "machdoch",
                "state": "executing",
                "message": "Running tests.",
                "executedTools": [],
                "outputSections": [],
                "cancellable": true,
                "actionOutput": {
                    "toolName": "shell_command",
                    "stream": "stdout",
                    "chunk": "tests passed"
                }
            }),
            123,
        );

        let inner = state.shared.inner.lock().expect("state lock");
        let status = create_status_locked(&inner);

        assert_eq!(status.sessions.len(), 1);
        assert_eq!(status.sessions[0].task, "Build the app");
        assert_eq!(status.sessions[0].logs[0].chunk, "tests passed");
    }

    #[test]
    fn snapshots_do_not_expose_approval_prompts() {
        let state = RemoteControlState::default();

        state.record_progress(
            "task-1",
            &json!({
                "task": "Build the app",
                "mode": "machdoch",
                "state": "executing",
                "message": "Waiting.",
                "executedTools": [],
                "outputSections": [],
                "cancellable": true,
                "approvalPrompt": {
                    "promptId": "approval-1",
                    "title": "Run command",
                    "message": "Allow shell command?",
                    "details": ["npm test"]
                }
            }),
            123,
        );

        let inner = state.shared.inner.lock().expect("state lock");
        let snapshot = create_snapshot_locked(&inner);
        let payload = serde_json::to_value(&snapshot).expect("snapshot should serialize");

        assert!(payload.get("approvalPrompts").is_none());
    }

    #[test]
    fn disabled_status_omits_handoff_secrets() {
        let status = create_status_locked(&RemoteControlInner::default());
        let payload = serde_json::to_value(&status).expect("status should serialize");

        assert!(!status.enabled);
        assert!(status.display_url.is_none());
        assert!(status.qr_svg.is_none());
        assert!(status.token_hint.is_none());
        assert!(payload.get("displayUrl").is_none());
        assert!(payload.get("qrSvg").is_none());
        assert!(payload.get("tokenHint").is_none());
    }
}
