use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

use crate::desktop_task::{request_desktop_task_cancel, DesktopTaskCancelMap};
use crate::runtime_snapshot::get_user_config_directory;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const REMOTE_CONTROL_COMMAND_EVENT: &str = "remote-control-command";
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
const MAX_SESSIONS: usize = 128;
const MAX_LOG_ENTRIES: usize = 160;
const MAX_TIMELINE_ENTRIES: usize = 80;
const MAX_COMMAND_ENTRIES: usize = 100;
const MAX_APPROVAL_PROMPTS: usize = 80;
const MAX_PAIRED_DEVICES: usize = 32;
const MAX_COMMAND_TEXT_CHARS: usize = 8_000;
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
    approval_prompts: VecDeque<RemoteApprovalPrompt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlConfigFile {
    #[serde(default = "default_remote_control_config_version")]
    version: u32,
    #[serde(default = "default_remote_control_port")]
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
    approval_prompts: Vec<RemoteApprovalPrompt>,
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
    task_id: Option<String>,
    prompt: Option<String>,
    decision: Option<String>,
    prompt_id: Option<String>,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommandRecord {
    command_id: String,
    kind: String,
    task_id: Option<String>,
    prompt_preview: Option<String>,
    decision: Option<String>,
    prompt_id: Option<String>,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteApprovalPrompt {
    prompt_id: String,
    task_id: String,
    title: String,
    message: String,
    details: Vec<String>,
    status: String,
    created_at: u64,
    resolved_at: Option<u64>,
    decision: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommandRequest {
    kind: String,
    task_id: Option<String>,
    prompt: Option<String>,
    decision: Option<String>,
    prompt_id: Option<String>,
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
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
        thread::spawn(move || {
            run_http_server(listener, shared, app_handle, shutdown);
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
        let progress_count = session.progress_count;

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

        if let Some(approval_prompt) = progress.get("approvalPrompt").and_then(Value::as_object) {
            let prompt_id = approval_prompt
                .get("promptId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{normalized_task_id}-approval-{progress_count}"));
            let details = approval_prompt
                .get("details")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|value| truncate_chars(value, 1_000))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let prompt = RemoteApprovalPrompt {
                prompt_id: prompt_id.clone(),
                task_id: normalized_task_id.to_string(),
                title: approval_prompt
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|value| truncate_chars(value, 200))
                    .unwrap_or_else(|| "Approval requested".to_string()),
                message: approval_prompt
                    .get("message")
                    .and_then(Value::as_str)
                    .map(|value| truncate_chars(value, 1_000))
                    .unwrap_or_else(|| "The local session is waiting for approval.".to_string()),
                details,
                status: approval_prompt
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_ascii_lowercase)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "pending".to_string()),
                created_at: timestamp,
                resolved_at: None,
                decision: None,
            };

            if let Some(existing) = inner
                .approval_prompts
                .iter_mut()
                .find(|entry| entry.prompt_id == prompt_id)
            {
                *existing = prompt;
            } else {
                push_bounded(&mut inner.approval_prompts, prompt, MAX_APPROVAL_PROMPTS);
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
                prompt_preview: event
                    .prompt
                    .as_deref()
                    .map(|value| truncate_chars(value, 240)),
                decision: event.decision.clone(),
                prompt_id: event.prompt_id.clone(),
                created_at: event.created_at,
            },
            MAX_COMMAND_ENTRIES,
        );
        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.updates.notify_all();
    }

    fn record_approval_decision(&self, event: &RemoteControlCommandEvent) {
        if event.kind != "approval-decision" {
            return;
        }

        let Some(prompt_id) = event.prompt_id.as_deref() else {
            return;
        };

        let Ok(mut inner) = self.shared.inner.lock() else {
            return;
        };

        if let Some(prompt) = inner
            .approval_prompts
            .iter_mut()
            .find(|entry| entry.prompt_id == prompt_id)
        {
            prompt.status = match event.decision.as_deref() {
                Some("approve") => "approved".to_string(),
                Some("reject") => "rejected".to_string(),
                _ => "resolved".to_string(),
            };
            prompt.decision = event.decision.clone();
            prompt.resolved_at = Some(event.created_at);
            inner.event_id = inner.event_id.saturating_add(1);
            self.shared.updates.notify_all();
        }
    }

    fn create_web_session(&self, user_agent: Option<&str>) -> Result<String, String> {
        self.ensure_config_loaded()?;

        let session_token = create_secure_token()?;
        let next_pairing_token = create_secure_token()?;
        let now = now_millis();
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to create a Mission Control web session.".to_string())?;

        prune_expired_paired_devices_locked(&mut inner.config, now);

        if inner.config.paired_devices.len() >= MAX_PAIRED_DEVICES {
            if let Some(stale_device_id) = inner
                .config
                .paired_devices
                .iter()
                .min_by_key(|device| device.last_seen_at)
                .map(|device| device.id.clone())
            {
                inner
                    .config
                    .paired_devices
                    .retain(|device| device.id != stale_device_id);
            }
        }

        inner.config.paired_devices.push(RemoteControlPairedDevice {
            id: create_device_id(),
            name: create_device_name(user_agent),
            token_hash: hash_remote_control_token(&session_token),
            created_at: now,
            last_seen_at: now,
            expires_at: now.saturating_add(WEB_SESSION_TTL_MS),
            user_agent: user_agent
                .map(|value| truncate_chars(value.trim(), 240))
                .filter(|value| !value.is_empty()),
        });
        inner.config.version = REMOTE_CONTROL_CONFIG_VERSION;

        if let Some(server) = inner.server.as_mut() {
            refresh_server_pairing_url(server, next_pairing_token)?;
        }

        write_remote_control_config_file(&inner.config)?;
        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.updates.notify_all();

        Ok(session_token)
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

fn run_http_server(
    listener: TcpListener,
    shared: Arc<RemoteControlShared>,
    app_handle: tauri::AppHandle,
    shutdown: Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let shared = shared.clone();
                let app_handle = app_handle.clone();
                let shutdown = shutdown.clone();

                thread::spawn(move || {
                    handle_connection(stream, shared, app_handle, shutdown);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(SERVER_ACCEPT_POLL_INTERVAL);
            }
            Err(_) => {
                thread::sleep(SERVER_ACCEPT_POLL_INTERVAL);
            }
        }
    }
}

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
    state.record_approval_decision(&event);

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
        "cancel" | "retry" | "continue" | "follow-up" | "approval-decision"
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

    if matches!(kind.as_str(), "cancel" | "retry" | "continue") && task_id.is_none() {
        return Err("This Mission Control command requires a taskId.".to_string());
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

    let decision = request
        .decision
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);

    if kind == "approval-decision" && !matches!(decision.as_deref(), Some("approve" | "reject")) {
        return Err("Approval decisions must be approve or reject.".to_string());
    }

    let prompt_id = request
        .prompt_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if kind == "approval-decision" && prompt_id.is_none() {
        return Err("Approval decisions require a promptId.".to_string());
    }

    Ok(RemoteControlCommandEvent {
        command_id: create_command_id(),
        kind,
        task_id,
        prompt,
        decision,
        prompt_id,
        created_at: now_millis(),
    })
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();

    if reader
        .read_line(&mut request_line)
        .map_err(|error| format!("Unable to read HTTP request: {error}"))?
        == 0
    {
        return Err("Empty HTTP request.".to_string());
    }

    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "HTTP request method is missing.".to_string())?
        .to_string();
    let target = parts
        .next()
        .ok_or_else(|| "HTTP request target is missing.".to_string())?
        .to_string();

    let path = split_target(&target);
    let mut headers = HashMap::new();

    loop {
        let mut header_line = String::new();
        let bytes_read = reader
            .read_line(&mut header_line)
            .map_err(|error| format!("Unable to read HTTP headers: {error}"))?;

        if bytes_read == 0 || header_line == "\r\n" || header_line == "\n" {
            break;
        }

        if let Some((key, value)) = header_line.split_once(':') {
            headers.insert(
                key.trim().to_ascii_lowercase(),
                value.trim().trim_end_matches('\r').to_string(),
            );
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);

    if content_length > MAX_HTTP_BODY_BYTES {
        return Err("Mission Control request body is too large.".to_string());
    }

    let mut body = vec![0; content_length];

    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|error| format!("Unable to read HTTP body: {error}"))?;
    }

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn split_target(target: &str) -> String {
    let path_and_query = target.split('#').next().unwrap_or(target);

    if let Some((path, _)) = path_and_query.split_once('?') {
        return path.to_string();
    }

    path_and_query.to_string()
}

fn request_has_bearer_token(request: &HttpRequest, token: &str) -> bool {
    request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

fn request_has_current_pairing_token(
    request: &HttpRequest,
    shared: &Arc<RemoteControlShared>,
) -> bool {
    let Ok(inner) = shared.inner.lock() else {
        return false;
    };

    let Some(server) = inner.server.as_ref() else {
        return false;
    };

    request_has_bearer_token(request, &server.token)
}

fn request_has_web_session(request: &HttpRequest, shared: &Arc<RemoteControlShared>) -> bool {
    let Some(session_token) = cookie_value(request, WEB_SESSION_COOKIE_NAME) else {
        return false;
    };

    let Ok(inner) = shared.inner.lock() else {
        return false;
    };

    let session_hash = hash_remote_control_token(&session_token);
    let now = now_millis();

    inner.config.paired_devices.iter().any(|device| {
        device.expires_at > now
            && constant_time_eq(device.token_hash.as_bytes(), session_hash.as_bytes())
    })
}

fn request_is_authorized(request: &HttpRequest, shared: &Arc<RemoteControlShared>) -> bool {
    request_has_web_session(request, shared)
}

fn state_changing_request_is_allowed(request: &HttpRequest) -> bool {
    if request
        .headers
        .get("x-machdoch-remote")
        .map(|value| value == "1")
        .unwrap_or(false)
        == false
    {
        return false;
    }

    if request
        .headers
        .get("sec-fetch-site")
        .map(|value| value == "cross-site")
        .unwrap_or(false)
    {
        return false;
    }

    let Some(origin) = request.headers.get("origin") else {
        return true;
    };
    let Some(host) = request.headers.get("host") else {
        return false;
    };

    origin == &format!("http://{host}")
}

fn cookie_value(request: &HttpRequest, name: &str) -> Option<String> {
    request.headers.get("cookie")?.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;

        if key.trim() != name {
            return None;
        }

        Some(value.trim().to_string())
    })
}

fn default_remote_control_config_version() -> u32 {
    REMOTE_CONTROL_CONFIG_VERSION
}

fn default_remote_control_port() -> u16 {
    DEFAULT_REMOTE_CONTROL_PORT
}

fn validate_remote_control_port(port: u16) -> Result<u16, String> {
    if port < MIN_REMOTE_CONTROL_PORT {
        return Err(format!(
            "Mission Control port must be between {MIN_REMOTE_CONTROL_PORT} and 65535."
        ));
    }

    Ok(port)
}

fn ensure_remote_control_port_available(port: u16) -> Result<(), String> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
        .map(|_| ())
        .map_err(|error| format!("Mission Control port {port} is not available: {error}"))
}

fn remote_control_config_path() -> Result<PathBuf, String> {
    Ok(get_user_config_directory()?.join(REMOTE_CONTROL_CONFIG_FILE_NAME))
}

fn load_remote_control_config_file() -> Result<RemoteControlConfigFile, String> {
    let config_path = remote_control_config_path()?;

    if !config_path.exists() {
        return Ok(RemoteControlConfigFile::default());
    }

    let raw = fs::read_to_string(&config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    let parsed = serde_json::from_str::<RemoteControlConfigFile>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;

    Ok(normalize_remote_control_config(parsed))
}

fn normalize_remote_control_config(mut config: RemoteControlConfigFile) -> RemoteControlConfigFile {
    config.version = REMOTE_CONTROL_CONFIG_VERSION;

    if validate_remote_control_port(config.port).is_err() {
        config.port = DEFAULT_REMOTE_CONTROL_PORT;
    }

    let now = now_millis();
    config.paired_devices.retain(|device| {
        !device.id.trim().is_empty()
            && !device.token_hash.trim().is_empty()
            && device.expires_at > now
    });
    config
        .paired_devices
        .sort_by(|left, right| right.last_seen_at.cmp(&left.last_seen_at));
    config.paired_devices.truncate(MAX_PAIRED_DEVICES);

    config
}

fn write_remote_control_config_file(config: &RemoteControlConfigFile) -> Result<(), String> {
    let config_path = remote_control_config_path()?;

    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
        secure_remote_control_config_directory(config_directory)?;
    }

    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize Mission Control settings: {error}"))?;
    fs::write(&config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;
    secure_remote_control_config_file(&config_path)
}

fn secure_remote_control_config_directory(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }

    Ok(())
}

fn secure_remote_control_config_file(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }

    Ok(())
}

fn prune_expired_paired_devices_locked(config: &mut RemoteControlConfigFile, now: u64) {
    config
        .paired_devices
        .retain(|device| device.expires_at > now);
}

fn hash_remote_control_token(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

fn create_device_id() -> String {
    let mut bytes = [0_u8; 12];

    if getrandom::fill(&mut bytes).is_ok() {
        return URL_SAFE_NO_PAD.encode(bytes);
    }

    format!("device-{}", now_millis())
}

fn create_device_name(user_agent: Option<&str>) -> String {
    user_agent
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, 80))
        .unwrap_or_else(|| "Remote browser".to_string())
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

fn create_session_cookie(session_token: &str) -> String {
    format!(
        "{WEB_SESSION_COOKIE_NAME}={session_token}; Path=/api; Max-Age={}; HttpOnly; SameSite=Strict",
        WEB_SESSION_TTL_MS / 1_000
    )
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

fn write_html_response(stream: &mut TcpStream, body: String) -> std::io::Result<()> {
    write_response(
        stream,
        200,
        body.into_bytes(),
        &[
            ("Content-Type", "text/html; charset=utf-8"),
            ("Cache-Control", "no-store"),
            (
                "Content-Security-Policy",
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ),
            ("Referrer-Policy", "no-referrer"),
        ],
    )
}

fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    body: Value,
    extra_headers: &[(&str, &str)],
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| b"{\"error\":\"json\"}".to_vec());
    let mut headers = vec![
        ("Content-Type", "application/json; charset=utf-8"),
        ("Cache-Control", "no-store"),
    ];
    headers.extend_from_slice(extra_headers);
    write_response(stream, status, bytes, &headers)
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    body: Vec<u8>,
    headers: &[(&str, &str)],
) -> std::io::Result<()> {
    write_headers(stream, status, headers, Some(body.len()))?;
    stream.write_all(&body)
}

fn write_headers(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(&str, &str)],
    content_length: Option<usize>,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\n")?;

    for (key, value) in headers {
        write!(stream, "{key}: {value}\r\n")?;
    }

    if let Some(content_length) = content_length {
        write!(stream, "Content-Length: {content_length}\r\n")?;
        write!(stream, "Connection: close\r\n")?;
    }

    write!(stream, "\r\n")
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
        approval_prompts: inner.approval_prompts.iter().cloned().rev().collect(),
    }
}

fn sorted_sessions(inner: &RemoteControlInner) -> Vec<RemoteTaskSession> {
    let mut sessions = inner.sessions.values().cloned().collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions
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

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();

    for index in 0..max_len {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        diff |= usize::from(left_byte ^ right_byte);
    }

    diff == 0
}

fn mission_control_html() -> String {
    r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Machdoch Mission Control</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #07111f; color: #e5edf7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #07111f; }
    button, input, textarea { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem; border-bottom: 1px solid #17263a; background: rgba(7, 17, 31, 0.94); backdrop-filter: blur(12px); }
    h1 { margin: 0; font-size: clamp(1.05rem, 4vw, 1.4rem); letter-spacing: 0; }
    main { width: min(1180px, 100%); margin: 0 auto; padding: 1rem; display: grid; gap: 1rem; }
    .status { display: inline-flex; align-items: center; gap: .5rem; color: #a6b7ca; font-size: .85rem; }
    .dot { width: .55rem; height: .55rem; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 4px rgba(34, 197, 94, .12); }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); align-items: start; }
    .panel, .task { border: 1px solid #17263a; background: #0b1728; border-radius: .5rem; overflow: hidden; }
    .panel { padding: 1rem; display: grid; gap: .75rem; }
    .task header { position: static; padding: .9rem 1rem; background: #0d1b2f; }
    .task-body { padding: 1rem; display: grid; gap: .9rem; }
    .meta { display: flex; flex-wrap: wrap; gap: .4rem; color: #9fb0c4; font-size: .78rem; }
    .pill { border: 1px solid #25405e; background: #10233a; border-radius: 999px; padding: .18rem .5rem; }
    .message { margin: 0; color: #d7e2ef; line-height: 1.5; overflow-wrap: anywhere; }
    .logs, .timeline, .commands { display: grid; gap: .45rem; max-height: 18rem; overflow: auto; padding-right: .2rem; }
    .log, .event, .command { border: 1px solid #16283f; background: #07111f; border-radius: .45rem; padding: .55rem; color: #cbd8e7; font-size: .8rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .event strong, .command strong { color: #f8fafc; }
    .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    button, a.button { border: 1px solid #2f4f72; background: #123252; color: #f8fbff; min-height: 2.35rem; border-radius: .45rem; padding: .45rem .7rem; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: .4rem; }
    button.secondary { background: #0b1728; color: #cbd8e7; }
    button.danger { border-color: #7f1d1d; background: #451a1a; color: #fecaca; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    form { display: grid; gap: .5rem; }
    textarea { width: 100%; min-height: 5rem; resize: vertical; border: 1px solid #25405e; background: #07111f; color: #f8fafc; border-radius: .45rem; padding: .7rem; }
    .empty { color: #8194aa; font-size: .86rem; margin: 0; }
    .toast { min-height: 1.4rem; color: #a7f3d0; font-size: .82rem; }
    @media (max-width: 680px) { header { align-items: flex-start; flex-direction: column; } main { padding: .75rem; } .actions button, .actions a.button { flex: 1 1 8rem; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div>
        <h1>Machdoch Mission Control</h1>
        <div class="status"><span class="dot"></span><span id="connection">Connecting</span></div>
      </div>
      <button class="secondary" id="refresh" type="button">Refresh</button>
    </header>
    <main>
      <section class="grid">
        <div class="panel">
          <h2>Active Sessions</h2>
          <div id="sessions"></div>
        </div>
        <div class="panel">
          <h2>Approval Prompts</h2>
          <div id="approvals"><p class="empty">No approval prompts are waiting.</p></div>
        </div>
        <div class="panel">
          <h2>Remote Commands</h2>
          <div class="commands" id="commands"><p class="empty">No remote commands yet.</p></div>
          <div class="toast" id="toast"></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    let pairingToken = new URLSearchParams(location.hash.slice(1)).get("pair")
      || new URLSearchParams(location.hash.slice(1)).get("token")
      || new URLSearchParams(location.search).get("pair")
      || new URLSearchParams(location.search).get("token")
      || "";
    const connection = document.getElementById("connection");
    const sessions = document.getElementById("sessions");
    const approvals = document.getElementById("approvals");
    const commands = document.getElementById("commands");
    const toast = document.getElementById("toast");
    const terminalStates = new Set(["completed", "planned", "blocked", "unsupported", "cancelled"]);

    if (pairingToken) {
      history.replaceState(null, "", location.pathname);
    }

    function api(path) {
      return path;
    }

    function authHeaders(extra = {}, includePairingToken = false) {
      const headers = {
        ...extra,
        "X-Machdoch-Remote": "1"
      };
      if (includePairingToken && pairingToken) {
        headers.Authorization = `Bearer ${pairingToken}`;
      }
      return headers;
    }

    async function establishSession() {
      if (!pairingToken) {
        return;
      }

      const response = await fetch(api("/api/session"), {
        method: "POST",
        headers: authHeaders({}, true)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const pairedResponse = await fetch(api("/api/status"), { headers: authHeaders() });
        if (pairedResponse.ok) return;
        throw new Error(payload.error || "Session setup failed.");
      }
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
      })[char]);
    }

    function age(timestamp) {
      if (!timestamp) return "";
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
      if (seconds < 60) return `${seconds}s ago`;
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      return `${Math.round(minutes / 60)}h ago`;
    }

    async function sendCommand(command) {
      const response = await fetch("/api/command", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Command failed.");
      toast.textContent = "Command queued locally.";
      setTimeout(() => { toast.textContent = ""; }, 2200);
    }

    function renderCommands(items) {
      if (!items.length) {
        commands.innerHTML = '<p class="empty">No remote commands yet.</p>';
        return;
      }
      commands.innerHTML = items.map((item) => `
        <div class="command">
          <strong>${escapeHtml(item.kind)}</strong>
          ${item.taskId ? `<div>task: ${escapeHtml(item.taskId)}</div>` : ""}
          ${item.promptPreview ? `<div>${escapeHtml(item.promptPreview)}</div>` : ""}
          <div class="meta">${age(item.createdAt)}</div>
        </div>
      `).join("");
    }

    function renderApprovals(items) {
      if (!items.length) {
        approvals.innerHTML = '<p class="empty">No approval prompts are waiting.</p>';
        return;
      }

      approvals.innerHTML = items.map((item) => {
        const pending = item.status === "pending";
        return `
          <div class="event">
            <strong>${escapeHtml(item.title)}</strong>
            <div>${escapeHtml(item.message)}</div>
            ${(item.details || []).map((detail) => `<div class="meta">${escapeHtml(detail)}</div>`).join("")}
            <div class="meta">
              <span class="pill">${escapeHtml(item.status)}</span>
              <span>${age(item.createdAt)}</span>
            </div>
            <div class="actions">
              <button data-approval="approve" data-prompt="${escapeHtml(item.promptId)}" ${pending ? "" : "disabled"}>Approve</button>
              <button class="danger" data-approval="reject" data-prompt="${escapeHtml(item.promptId)}" ${pending ? "" : "disabled"}>Reject</button>
            </div>
          </div>
        `;
      }).join("");
    }

    function renderSessions(items) {
      if (!items.length) {
        sessions.innerHTML = '<p class="empty">No task progress has streamed yet.</p>';
        return;
      }

      sessions.innerHTML = items.map((session) => {
        const isTerminal = terminalStates.has(session.state);
        const logs = [...(session.logs || [])].slice(-8).reverse();
        const timeline = [...(session.timeline || [])].slice(-8).reverse();
        return `
          <article class="task">
            <header>
              <div>
                <strong>${escapeHtml(session.task)}</strong>
                <div class="meta">
                  <span class="pill">${escapeHtml(session.state)}</span>
                  <span class="pill">${escapeHtml(session.mode)}</span>
                  <span>${age(session.updatedAt)}</span>
                </div>
              </div>
            </header>
            <div class="task-body">
              <p class="message">${escapeHtml(session.message)}</p>
              <div class="actions">
                <button class="danger" data-kind="cancel" data-task="${escapeHtml(session.taskId)}" ${session.cancellable ? "" : "disabled"}>Cancel</button>
                <button data-kind="retry" data-task="${escapeHtml(session.taskId)}" ${isTerminal ? "" : "disabled"}>Retry</button>
                <button data-kind="continue" data-task="${escapeHtml(session.taskId)}" ${isTerminal ? "" : "disabled"}>Continue</button>
              </div>
              <form data-followup="${escapeHtml(session.taskId)}">
                <textarea name="prompt" placeholder="Queue a follow-up prompt"></textarea>
                <button type="submit">Queue Follow-up</button>
              </form>
              <div>
                <h3>Streamed Logs</h3>
                <div class="logs">
                  ${logs.length ? logs.map((log) => `<div class="log">${escapeHtml(log.chunk)}</div>`).join("") : '<p class="empty">No stdout or stderr chunks yet.</p>'}
                </div>
              </div>
              <div>
                <h3>Timeline</h3>
                <div class="timeline">
                  ${timeline.length ? timeline.map((entry) => `<div class="event"><strong>${escapeHtml(entry.label)}</strong><div>${escapeHtml(entry.detail || entry.phase)}</div></div>`).join("") : '<p class="empty">No timeline events yet.</p>'}
                </div>
              </div>
            </div>
          </article>
        `;
      }).join("");
    }

    function render(snapshot) {
      connection.textContent = snapshot.enabled ? `Live (${snapshot.sessions.length})` : "Disabled";
      renderSessions(snapshot.sessions || []);
      renderCommands(snapshot.commands || []);
      renderApprovals(snapshot.approvalPrompts || []);
    }

    sessions.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-kind]");
      if (!button) return;
      void sendCommand({
        kind: button.dataset.kind,
        taskId: button.dataset.task
      }).catch((error) => { toast.textContent = error.message; });
    });

    sessions.addEventListener("submit", (event) => {
      const form = event.target.closest("form[data-followup]");
      if (!form) return;
      event.preventDefault();
      const textarea = form.elements.prompt;
      const prompt = textarea.value.trim();
      if (!prompt) return;
      textarea.value = "";
      void sendCommand({
        kind: "follow-up",
        taskId: form.dataset.followup,
        prompt
      }).catch((error) => { toast.textContent = error.message; });
    });

    approvals.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-approval]");
      if (!button) return;
      void sendCommand({
        kind: "approval-decision",
        promptId: button.dataset.prompt,
        decision: button.dataset.approval
      }).catch((error) => { toast.textContent = error.message; });
    });

    document.getElementById("refresh").addEventListener("click", () => {
      void fetch(api("/api/status"), { headers: authHeaders() })
        .then((response) => response.ok ? response : Promise.reject(new Error("Refresh failed")))
        .then((response) => response.json())
        .then(render)
        .catch((error) => { connection.textContent = error.message; });
    });

    void establishSession()
      .then(() => fetch(api("/api/status"), { headers: authHeaders() }))
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("This browser is not paired. Open the latest QR/link from desktop.")))
      .then(render)
      .then(() => {
        const events = new EventSource(api("/api/events"), { withCredentials: true });
        events.addEventListener("snapshot", (event) => render(JSON.parse(event.data)));
        events.onerror = () => { connection.textContent = "Reconnecting"; };
      })
      .catch((error) => { connection.textContent = error.message; });
  </script>
</body>
</html>"#
        .to_string()
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
            prompt: Some("   ".to_string()),
            decision: None,
            prompt_id: None,
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
    fn approval_decisions_require_prompt_id() {
        let result = normalize_command(RemoteCommandRequest {
            kind: "approval-decision".to_string(),
            task_id: Some("task-1".to_string()),
            prompt: None,
            decision: Some("approve".to_string()),
            prompt_id: None,
        });

        assert!(result.is_err());
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
    fn approval_prompts_round_trip_through_snapshot_and_decision() {
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

        let decision = normalize_command(RemoteCommandRequest {
            kind: "approval-decision".to_string(),
            task_id: Some("task-1".to_string()),
            prompt: None,
            decision: Some("approve".to_string()),
            prompt_id: Some("approval-1".to_string()),
        })
        .expect("approval decision should normalize");

        state.record_approval_decision(&decision);

        let inner = state.shared.inner.lock().expect("state lock");
        let snapshot = create_snapshot_locked(&inner);

        assert_eq!(snapshot.approval_prompts.len(), 1);
        assert_eq!(snapshot.approval_prompts[0].prompt_id, "approval-1");
        assert_eq!(snapshot.approval_prompts[0].status, "approved");
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
