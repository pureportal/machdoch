use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
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
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tokio::net::TcpListener as TokioTcpListener;

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
    approval_prompts: VecDeque<RemoteApprovalPrompt>,
    shell: Option<RemoteShellSnapshot>,
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
    decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_id: Option<String>,
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
    profile: Option<String>,
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
    decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_preview: Option<String>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteShellSnapshot {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    captured_at: u64,
    #[serde(default)]
    active_session_id: Option<String>,
    #[serde(default)]
    sessions: Vec<RemoteShellSession>,
    #[serde(default)]
    visible_messages: Vec<RemoteShellMessage>,
    #[serde(default)]
    composer: Option<RemoteShellComposer>,
    #[serde(default)]
    runtime: Option<RemoteShellRuntime>,
    #[serde(default)]
    scheduler: Option<RemoteShellScheduler>,
    #[serde(default)]
    context_packs: Vec<RemoteShellContextPack>,
    #[serde(default)]
    prompt_history: Vec<String>,
    #[serde(default)]
    voice: Option<RemoteShellVoice>,
    #[serde(default)]
    quick_task: Option<RemoteShellQuickTask>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellSession {
    id: String,
    title: String,
    status: String,
    workspace: Option<String>,
    profile: Option<String>,
    provider: String,
    model: String,
    mode: Option<String>,
    effective_mode: String,
    created_at: u64,
    updated_at: u64,
    archived_at: Option<u64>,
    pinned_at: Option<u64>,
    tags: Vec<String>,
    message_count: usize,
    prompt_history_count: usize,
    attachment_count: usize,
    running_task_id: Option<String>,
    can_rename: bool,
    can_delete: bool,
    can_archive: bool,
    can_pin: bool,
    can_duplicate: bool,
    can_branch: bool,
    special_kind: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellMessage {
    id: String,
    role: String,
    content: String,
    created_at: Option<u64>,
    task_id: Option<String>,
    intent: Option<String>,
    attachments: Vec<RemoteShellAttachment>,
    source: Option<RemoteShellMessageSource>,
    actions: RemoteShellMessageActions,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellMessageSource {
    kind: String,
    status: Option<String>,
    title: Option<String>,
    summary: Option<String>,
    mode: Option<String>,
    entries: Vec<RemoteShellTraceEntry>,
    timeline: Vec<RemoteShellTraceEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellTraceEntry {
    label: String,
    detail: String,
    tone: Option<String>,
    timestamp: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellMessageActions {
    can_retry: bool,
    can_continue: bool,
    can_save_as_context_pack: bool,
    can_speak: bool,
    is_speaking: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellAttachment {
    id: String,
    kind: String,
    name: String,
    path: String,
    parent: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellComposer {
    session_id: String,
    draft: String,
    provider: String,
    model: String,
    mode: String,
    default_mode: String,
    workspace: Option<String>,
    workspace_label: String,
    can_send: bool,
    send_disabled_reason: Option<String>,
    is_executing: bool,
    session_memory_enabled: bool,
    global_memory_available: bool,
    global_memory_enabled: bool,
    ui_control_available: bool,
    ui_control_enabled: bool,
    ui_control_description: String,
    attachments: Vec<RemoteShellAttachment>,
    chooser_providers: Vec<String>,
    matched_context_pack_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellRuntime {
    loading: bool,
    error: Option<String>,
    has_any_provider: bool,
    provider_statuses: Vec<RemoteShellProviderStatus>,
    mode: Option<String>,
    profile: Option<String>,
    ui_control: Option<RemoteShellRuntimeCapability>,
    web_search: Option<RemoteShellRuntimeCapability>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellProviderStatus {
    provider: String,
    available: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellRuntimeCapability {
    available: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellScheduler {
    workspace_root: Option<String>,
    loading: bool,
    error: Option<String>,
    jobs: Vec<RemoteShellSchedulerJob>,
    runs: Vec<RemoteShellSchedulerRun>,
    updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellSchedulerJob {
    id: String,
    name: String,
    status: String,
    schedule: String,
    prompt_preview: String,
    next_run_at: Option<u64>,
    last_started_at: Option<u64>,
    last_finished_at: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellSchedulerRun {
    id: String,
    job_id: String,
    source: String,
    status: String,
    scheduled_for: u64,
    updated_at: u64,
    attempt: u32,
    max_attempts: u32,
    started_at: Option<u64>,
    finished_at: Option<u64>,
    next_attempt_at: Option<u64>,
    error: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellContextPack {
    id: String,
    name: String,
    workspace: Option<String>,
    instructions_preview: String,
    prompt_preview: String,
    attachment_count: usize,
    variables: Vec<String>,
    matched: bool,
    provider: Option<String>,
    model: Option<String>,
    mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellVoice {
    supported: bool,
    auto_speak_responses: bool,
    speaking_message_id: Option<String>,
    speech_input_supported: bool,
    speech_input_enabled: bool,
    speech_input_status: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellQuickTask {
    status: String,
    draft: String,
    is_executing: bool,
    provider: String,
    model: String,
    autopilot_enabled: bool,
    global_memory_enabled: bool,
    ui_control_enabled: bool,
    attachment_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommandRequest {
    kind: String,
    task_id: Option<String>,
    session_id: Option<String>,
    prompt: Option<String>,
    decision: Option<String>,
    prompt_id: Option<String>,
    title: Option<String>,
    tags: Option<Vec<String>>,
    provider: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    profile: Option<String>,
    workspace: Option<String>,
    enabled: Option<bool>,
    attachment_id: Option<String>,
    context_pack_id: Option<String>,
    message_id: Option<String>,
    job_id: Option<String>,
    run_id: Option<String>,
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
        let listener = TokioTcpListener::from_std(listener)
            .map_err(|error| format!("Unable to create Mission Control web listener: {error}"))?;
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
                session_id: event.session_id.clone(),
                prompt_preview: event
                    .prompt
                    .as_deref()
                    .map(|value| truncate_chars(value, 240)),
                decision: event.decision.clone(),
                prompt_id: event.prompt_id.clone(),
                title: event.title.clone(),
                target_preview: create_command_target_preview(event),
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
    listener: TokioTcpListener,
    shared: Arc<RemoteControlShared>,
    app_handle: tauri::AppHandle,
    shutdown: Arc<AtomicBool>,
) {
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
    control_state.record_approval_decision(&event);

    if event.kind == "cancel" {
        if let Some(task_id) = event.task_id.as_deref() {
            let cancel_state = state.app_handle.state::<DesktopTaskCancelMap>();
            request_desktop_task_cancel(&cancel_state, task_id);
        }
    }

    let _ = state.app_handle.emit(REMOTE_CONTROL_COMMAND_EVENT, event.clone());

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
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
}

fn header_to_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn headers_have_bearer_token(headers: &HeaderMap, token: &str) -> bool {
    header_to_str(headers, "authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

fn headers_have_current_pairing_token(
    headers: &HeaderMap,
    shared: &Arc<RemoteControlShared>,
) -> bool {
    let Ok(inner) = shared.inner.lock() else {
        return false;
    };

    let Some(server) = inner.server.as_ref() else {
        return false;
    };

    headers_have_bearer_token(headers, &server.token)
}

fn headers_have_web_session(headers: &HeaderMap, shared: &Arc<RemoteControlShared>) -> bool {
    let Some(session_token) = cookie_value_from_header(header_to_str(headers, "cookie"), WEB_SESSION_COOKIE_NAME) else {
        return false;
    };

    let Ok(mut inner) = shared.inner.lock() else {
        return false;
    };

    let session_hash = hash_remote_control_token(&session_token);
    let now = now_millis();

    if let Some(device) = inner.config.paired_devices.iter_mut().find(|device| {
        device.expires_at > now
            && constant_time_eq(device.token_hash.as_bytes(), session_hash.as_bytes())
    }) {
        device.last_seen_at = now;
        return true;
    }

    false
}

fn headers_are_authorized(headers: &HeaderMap, shared: &Arc<RemoteControlShared>) -> bool {
    headers_have_web_session(headers, shared)
}

fn state_changing_headers_allowed(headers: &HeaderMap) -> bool {
    if header_to_str(headers, "x-machdoch-remote") != Some("1") {
        return false;
    }

    if header_to_str(headers, "sec-fetch-site") == Some("cross-site") {
        return false;
    }

    let Some(origin) = header_to_str(headers, "origin") else {
        return true;
    };
    let Some(host) = header_to_str(headers, "host") else {
        return false;
    };

    origin == format!("http://{host}")
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
        "cancel"
            | "retry"
            | "continue"
            | "follow-up"
            | "approval-decision"
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
            | "set-session-profile"
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
            | "set-session-profile"
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
    let profile = request
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, MAX_REMOTE_SHORT_TEXT_CHARS));
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

    if matches!(kind.as_str(), "save-message-context-pack" | "speak-message") && message_id.is_none()
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

    if matches!(kind.as_str(), "scheduler-retry-run" | "scheduler-cancel-run") && run_id.is_none()
    {
        return Err("This Mission Control command requires a runId.".to_string());
    }

    Ok(RemoteControlCommandEvent {
        command_id: create_command_id(),
        kind,
        task_id,
        session_id,
        prompt,
        decision,
        prompt_id,
        title,
        tags,
        provider,
        model,
        mode,
        profile,
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
    cookie_value_from_header(request.headers.get("cookie").map(String::as_str), name)
}

fn cookie_value_from_header(cookie_header: Option<&str>, name: &str) -> Option<String> {
    cookie_header?.split(';').find_map(|part| {
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
        shell: inner.shell.clone(),
    }
}

fn sorted_sessions(inner: &RemoteControlInner) -> Vec<RemoteTaskSession> {
    let mut sessions = inner.sessions.values().cloned().collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions
}

fn sanitize_shell_snapshot(mut snapshot: RemoteShellSnapshot) -> Result<RemoteShellSnapshot, String> {
    if snapshot.version == 0 {
        snapshot.version = 1;
    }

    if snapshot.captured_at == 0 {
        snapshot.captured_at = now_millis();
    }

    snapshot.active_session_id =
        sanitize_optional_text(snapshot.active_session_id, MAX_REMOTE_SHORT_TEXT_CHARS);

    snapshot.sessions = snapshot
        .sessions
        .into_iter()
        .take(MAX_REMOTE_SHELL_SESSIONS)
        .filter_map(sanitize_shell_session)
        .collect();

    snapshot.visible_messages = snapshot
        .visible_messages
        .into_iter()
        .take(MAX_REMOTE_SHELL_MESSAGES)
        .filter_map(sanitize_shell_message)
        .collect();

    snapshot.composer = snapshot.composer.and_then(sanitize_shell_composer);
    snapshot.runtime = snapshot.runtime.map(sanitize_shell_runtime);
    snapshot.scheduler = snapshot.scheduler.map(sanitize_shell_scheduler);
    snapshot.context_packs = snapshot
        .context_packs
        .into_iter()
        .take(MAX_REMOTE_CONTEXT_PACKS)
        .filter_map(sanitize_shell_context_pack)
        .collect();
    snapshot.prompt_history = snapshot
        .prompt_history
        .into_iter()
        .map(|prompt| sanitize_text(prompt, MAX_REMOTE_TEXT_CHARS))
        .filter(|prompt| !prompt.is_empty())
        .take(MAX_REMOTE_PROMPT_HISTORY)
        .collect();
    snapshot.voice = snapshot.voice.map(sanitize_shell_voice);
    snapshot.quick_task = snapshot.quick_task.map(sanitize_shell_quick_task);

    Ok(snapshot)
}

fn sanitize_shell_session(mut session: RemoteShellSession) -> Option<RemoteShellSession> {
    session.id = sanitize_text(session.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if session.id.is_empty() {
        return None;
    }

    session.title = sanitize_text(session.title, MAX_REMOTE_SHORT_TEXT_CHARS);
    if session.title.is_empty() {
        session.title = "Untitled session".to_string();
    }
    session.status = sanitize_text(session.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.workspace = sanitize_optional_text(session.workspace, MAX_REMOTE_TEXT_CHARS);
    session.profile = sanitize_optional_text(session.profile, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.provider = sanitize_text(session.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.model = sanitize_text(session.model, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.mode = sanitize_optional_text(session.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.effective_mode = sanitize_text(session.effective_mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.tags = session
        .tags
        .into_iter()
        .map(|tag| sanitize_text(tag, 64))
        .filter(|tag| !tag.is_empty())
        .take(24)
        .collect();
    session.running_task_id =
        sanitize_optional_text(session.running_task_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    session.special_kind = sanitize_optional_text(session.special_kind, MAX_REMOTE_SHORT_TEXT_CHARS);

    Some(session)
}

fn sanitize_shell_message(mut message: RemoteShellMessage) -> Option<RemoteShellMessage> {
    message.id = sanitize_text(message.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if message.id.is_empty() {
        return None;
    }

    message.role = sanitize_text(message.role, MAX_REMOTE_SHORT_TEXT_CHARS);
    message.content = sanitize_text(message.content, MAX_REMOTE_TEXT_CHARS);
    message.task_id = sanitize_optional_text(message.task_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    message.intent = sanitize_optional_text(message.intent, MAX_REMOTE_SHORT_TEXT_CHARS);
    message.attachments = message
        .attachments
        .into_iter()
        .take(24)
        .filter_map(sanitize_shell_attachment)
        .collect();
    message.source = message.source.map(sanitize_shell_message_source);

    Some(message)
}

fn sanitize_shell_message_source(mut source: RemoteShellMessageSource) -> RemoteShellMessageSource {
    source.kind = sanitize_text(source.kind, MAX_REMOTE_SHORT_TEXT_CHARS);
    source.status = sanitize_optional_text(source.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    source.title = sanitize_optional_text(source.title, MAX_REMOTE_SHORT_TEXT_CHARS);
    source.summary = sanitize_optional_text(source.summary, MAX_REMOTE_TEXT_CHARS);
    source.mode = sanitize_optional_text(source.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    source.entries = source
        .entries
        .into_iter()
        .take(24)
        .filter_map(sanitize_shell_trace_entry)
        .collect();
    source.timeline = source
        .timeline
        .into_iter()
        .take(40)
        .filter_map(sanitize_shell_trace_entry)
        .collect();
    source
}

fn sanitize_shell_trace_entry(mut entry: RemoteShellTraceEntry) -> Option<RemoteShellTraceEntry> {
    entry.label = sanitize_text(entry.label, MAX_REMOTE_SHORT_TEXT_CHARS);
    entry.detail = sanitize_text(entry.detail, 1_500);
    entry.tone = sanitize_optional_text(entry.tone, MAX_REMOTE_SHORT_TEXT_CHARS);

    if entry.label.is_empty() && entry.detail.is_empty() {
        return None;
    }

    Some(entry)
}

fn sanitize_shell_attachment(mut attachment: RemoteShellAttachment) -> Option<RemoteShellAttachment> {
    attachment.id = sanitize_text(attachment.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    attachment.kind = sanitize_text(attachment.kind, MAX_REMOTE_SHORT_TEXT_CHARS);
    attachment.name = sanitize_text(attachment.name, MAX_REMOTE_SHORT_TEXT_CHARS);
    attachment.path = sanitize_text(attachment.path, MAX_REMOTE_TEXT_CHARS);
    attachment.parent = sanitize_optional_text(attachment.parent, MAX_REMOTE_TEXT_CHARS);

    if attachment.id.is_empty() || attachment.name.is_empty() {
        return None;
    }

    Some(attachment)
}

fn sanitize_shell_composer(mut composer: RemoteShellComposer) -> Option<RemoteShellComposer> {
    composer.session_id = sanitize_text(composer.session_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if composer.session_id.is_empty() {
        return None;
    }

    composer.draft = sanitize_text(composer.draft, MAX_REMOTE_TEXT_CHARS);
    composer.provider = sanitize_text(composer.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.model = sanitize_text(composer.model, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.mode = sanitize_text(composer.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.default_mode = sanitize_text(composer.default_mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.workspace = sanitize_optional_text(composer.workspace, MAX_REMOTE_TEXT_CHARS);
    composer.workspace_label = sanitize_text(composer.workspace_label, MAX_REMOTE_SHORT_TEXT_CHARS);
    composer.send_disabled_reason =
        sanitize_optional_text(composer.send_disabled_reason, MAX_REMOTE_TEXT_CHARS);
    composer.ui_control_description =
        sanitize_text(composer.ui_control_description, MAX_REMOTE_TEXT_CHARS);
    composer.attachments = composer
        .attachments
        .into_iter()
        .take(24)
        .filter_map(sanitize_shell_attachment)
        .collect();
    composer.chooser_providers = composer
        .chooser_providers
        .into_iter()
        .map(|provider| sanitize_text(provider, MAX_REMOTE_SHORT_TEXT_CHARS))
        .filter(|provider| !provider.is_empty())
        .take(12)
        .collect();
    composer.matched_context_pack_ids = composer
        .matched_context_pack_ids
        .into_iter()
        .map(|id| sanitize_text(id, MAX_REMOTE_SHORT_TEXT_CHARS))
        .filter(|id| !id.is_empty())
        .take(24)
        .collect();

    Some(composer)
}

fn sanitize_shell_runtime(mut runtime: RemoteShellRuntime) -> RemoteShellRuntime {
    runtime.error = sanitize_optional_text(runtime.error, MAX_REMOTE_TEXT_CHARS);
    runtime.provider_statuses = runtime
        .provider_statuses
        .into_iter()
        .map(|mut status| {
            status.provider = sanitize_text(status.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
            status.reason = sanitize_optional_text(status.reason, MAX_REMOTE_TEXT_CHARS);
            status
        })
        .filter(|status| !status.provider.is_empty())
        .take(12)
        .collect();
    runtime.mode = sanitize_optional_text(runtime.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    runtime.profile = sanitize_optional_text(runtime.profile, MAX_REMOTE_SHORT_TEXT_CHARS);
    runtime.ui_control = runtime.ui_control.map(sanitize_shell_runtime_capability);
    runtime.web_search = runtime.web_search.map(sanitize_shell_runtime_capability);
    runtime
}

fn sanitize_shell_runtime_capability(
    mut capability: RemoteShellRuntimeCapability,
) -> RemoteShellRuntimeCapability {
    capability.reason = sanitize_optional_text(capability.reason, MAX_REMOTE_TEXT_CHARS);
    capability
}

fn sanitize_shell_scheduler(mut scheduler: RemoteShellScheduler) -> RemoteShellScheduler {
    scheduler.workspace_root = sanitize_optional_text(scheduler.workspace_root, MAX_REMOTE_TEXT_CHARS);
    scheduler.error = sanitize_optional_text(scheduler.error, MAX_REMOTE_TEXT_CHARS);
    scheduler.jobs = scheduler
        .jobs
        .into_iter()
        .take(MAX_REMOTE_SCHEDULER_JOBS)
        .filter_map(sanitize_shell_scheduler_job)
        .collect();
    scheduler.runs = scheduler
        .runs
        .into_iter()
        .take(MAX_REMOTE_SCHEDULER_RUNS)
        .filter_map(sanitize_shell_scheduler_run)
        .collect();
    scheduler
}

fn sanitize_shell_scheduler_job(mut job: RemoteShellSchedulerJob) -> Option<RemoteShellSchedulerJob> {
    job.id = sanitize_text(job.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if job.id.is_empty() {
        return None;
    }

    job.name = sanitize_text(job.name, MAX_REMOTE_SHORT_TEXT_CHARS);
    job.status = sanitize_text(job.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    job.schedule = sanitize_text(job.schedule, MAX_REMOTE_SHORT_TEXT_CHARS);
    job.prompt_preview = sanitize_text(job.prompt_preview, 1_000);
    Some(job)
}

fn sanitize_shell_scheduler_run(mut run: RemoteShellSchedulerRun) -> Option<RemoteShellSchedulerRun> {
    run.id = sanitize_text(run.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    run.job_id = sanitize_text(run.job_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if run.id.is_empty() || run.job_id.is_empty() {
        return None;
    }

    run.source = sanitize_text(run.source, MAX_REMOTE_SHORT_TEXT_CHARS);
    run.status = sanitize_text(run.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    run.error = sanitize_optional_text(run.error, MAX_REMOTE_TEXT_CHARS);
    run.summary = sanitize_optional_text(run.summary, MAX_REMOTE_TEXT_CHARS);
    Some(run)
}

fn sanitize_shell_context_pack(mut pack: RemoteShellContextPack) -> Option<RemoteShellContextPack> {
    pack.id = sanitize_text(pack.id, MAX_REMOTE_SHORT_TEXT_CHARS);
    if pack.id.is_empty() {
        return None;
    }

    pack.name = sanitize_text(pack.name, MAX_REMOTE_SHORT_TEXT_CHARS);
    pack.workspace = sanitize_optional_text(pack.workspace, MAX_REMOTE_TEXT_CHARS);
    pack.instructions_preview = sanitize_text(pack.instructions_preview, 1_000);
    pack.prompt_preview = sanitize_text(pack.prompt_preview, 1_000);
    pack.variables = pack
        .variables
        .into_iter()
        .map(|variable| sanitize_text(variable, MAX_REMOTE_SHORT_TEXT_CHARS))
        .filter(|variable| !variable.is_empty())
        .take(16)
        .collect();
    pack.provider = sanitize_optional_text(pack.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
    pack.model = sanitize_optional_text(pack.model, MAX_REMOTE_SHORT_TEXT_CHARS);
    pack.mode = sanitize_optional_text(pack.mode, MAX_REMOTE_SHORT_TEXT_CHARS);
    Some(pack)
}

fn sanitize_shell_voice(mut voice: RemoteShellVoice) -> RemoteShellVoice {
    voice.speaking_message_id =
        sanitize_optional_text(voice.speaking_message_id, MAX_REMOTE_SHORT_TEXT_CHARS);
    voice.speech_input_status =
        sanitize_optional_text(voice.speech_input_status, MAX_REMOTE_TEXT_CHARS);
    voice
}

fn sanitize_shell_quick_task(mut quick_task: RemoteShellQuickTask) -> RemoteShellQuickTask {
    quick_task.status = sanitize_text(quick_task.status, MAX_REMOTE_SHORT_TEXT_CHARS);
    quick_task.draft = sanitize_text(quick_task.draft, MAX_REMOTE_TEXT_CHARS);
    quick_task.provider = sanitize_text(quick_task.provider, MAX_REMOTE_SHORT_TEXT_CHARS);
    quick_task.model = sanitize_text(quick_task.model, MAX_REMOTE_SHORT_TEXT_CHARS);
    quick_task
}

fn sanitize_text(value: String, max_chars: usize) -> String {
    truncate_chars(value.trim(), max_chars)
}

fn sanitize_optional_text(value: Option<String>, max_chars: usize) -> Option<String> {
    value
        .map(|value| sanitize_text(value, max_chars))
        .filter(|value| !value.is_empty())
}

fn create_command_target_preview(event: &RemoteControlCommandEvent) -> Option<String> {
    [
        event.session_id.as_deref().map(|value| format!("session:{value}")),
        event.task_id.as_deref().map(|value| format!("task:{value}")),
        event.job_id.as_deref().map(|value| format!("job:{value}")),
        event.run_id.as_deref().map(|value| format!("run:{value}")),
        event.message_id.as_deref().map(|value| format!("message:{value}")),
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
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #020817; color: #e5edf7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #020817; }
    button, input, select, textarea { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 19rem minmax(0, 1fr) 25rem; grid-template-rows: auto minmax(0, 1fr); }
    .topbar { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .85rem 1rem; border-bottom: 1px solid #142033; background: #07111f; }
    .brand { display: grid; gap: .15rem; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 1.1rem; }
    h2 { font-size: .92rem; color: #f8fafc; }
    h3 { font-size: .78rem; color: #cbd5e1; text-transform: uppercase; }
    .status { display: inline-flex; align-items: center; gap: .5rem; color: #9fb0c4; font-size: .78rem; }
    .dot { width: .55rem; height: .55rem; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 4px rgba(34, 197, 94, .12); }
    .sidebar, .monitor { min-height: 0; overflow: auto; border-right: 1px solid #101827; background: #050d19; }
    .monitor { border-left: 1px solid #101827; border-right: 0; }
    .main { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; background: #020817; }
    .section { padding: .85rem; display: grid; gap: .7rem; border-bottom: 1px solid #101827; }
    .panel, .item, .message, .task { border: 1px solid #17263a; background: #07111f; border-radius: .5rem; }
    .panel { padding: .8rem; display: grid; gap: .65rem; }
    .item { width: 100%; padding: .65rem; color: inherit; text-align: left; cursor: pointer; }
    .item.active { border-color: #38bdf8; background: #0c1b2d; }
    .item strong, .message strong, .task strong { color: #f8fafc; }
    .conversation { min-height: 0; overflow: auto; padding: 1rem; display: grid; align-content: start; gap: .75rem; }
    .message { padding: .8rem; display: grid; gap: .55rem; line-height: 1.5; overflow-wrap: anywhere; }
    .message.user { border-color: #1f3b56; background: #081827; }
    .message.agent { border-color: #243044; background: #080f1c; }
    .content { white-space: pre-wrap; }
    .composer { border-top: 1px solid #101827; background: #050d19; padding: .85rem; display: grid; gap: .65rem; }
    .row, .actions, .meta { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; }
    .meta { color: #8fa4bb; font-size: .74rem; }
    .pill { border: 1px solid #25405e; background: #0d2138; border-radius: 999px; padding: .15rem .45rem; color: #b7c8dc; }
    .pill.good { border-color: #14532d; background: #052e1c; color: #bbf7d0; }
    .pill.bad { border-color: #7f1d1d; background: #361313; color: #fecaca; }
    button, .button { border: 1px solid #2c4663; background: #10243a; color: #f8fbff; min-height: 2rem; border-radius: .4rem; padding: .35rem .58rem; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: .35rem; }
    button.secondary { background: #07111f; color: #cbd8e7; }
    button.danger { border-color: #7f1d1d; background: #451a1a; color: #fecaca; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    input, select, textarea { width: 100%; border: 1px solid #25405e; background: #020817; color: #f8fafc; border-radius: .4rem; padding: .55rem; }
    select, input { min-height: 2.2rem; }
    textarea { min-height: 5.5rem; resize: vertical; }
    .field-grid { display: grid; gap: .55rem; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .stack { display: grid; gap: .55rem; }
    .scroll-list { display: grid; gap: .5rem; max-height: 19rem; overflow: auto; padding-right: .15rem; }
    .trace, .log, .event, .command { border: 1px solid #16283f; background: #020817; border-radius: .4rem; padding: .55rem; color: #cbd8e7; font-size: .78rem; line-height: 1.42; white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { color: #8194aa; font-size: .86rem; margin: 0; }
    .toast { min-height: 1.4rem; color: #a7f3d0; font-size: .82rem; }
    @media (max-width: 1180px) { .shell { grid-template-columns: 17rem minmax(0, 1fr); } .monitor { grid-column: 1 / -1; border-left: 0; border-top: 1px solid #101827; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); align-content: start; } }
    @media (max-width: 760px) { .shell { display: block; } .topbar { position: sticky; top: 0; z-index: 2; } .sidebar, .monitor, .conversation { max-height: none; overflow: visible; } .field-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <h1>Machdoch Mission Control</h1>
        <div class="status"><span class="dot"></span><span id="connection">Connecting</span></div>
      </div>
    </header>
    <aside class="sidebar">
      <section class="section">
        <div class="row">
          <h2>Sessions</h2>
          <button class="secondary" id="createSession" type="button">New</button>
        </div>
        <div class="scroll-list" id="shellSessions"><p class="empty">Waiting for desktop shell state.</p></div>
      </section>
      <section class="section">
        <h2>Runtime</h2>
        <div id="runtimePanel"><p class="empty">No runtime snapshot yet.</p></div>
      </section>
    </aside>
    <main class="main">
      <section class="section" id="sessionHeader"></section>
      <section class="conversation" id="conversation"><p class="empty">No conversation messages yet.</p></section>
      <section class="composer">
        <form class="stack" id="remotePromptForm">
          <textarea id="remotePrompt" name="prompt" placeholder="Prompt the selected session"></textarea>
          <div class="field-grid">
            <select id="providerSelect" aria-label="Provider"></select>
            <input id="modelInput" aria-label="Model" placeholder="Model">
            <select id="modeSelect" aria-label="Mode">
              <option value="">Workspace default</option>
              <option value="ask">Ask</option>
              <option value="machdoch">Machdoch</option>
            </select>
          </div>
          <div class="actions">
            <button type="submit">Run Prompt</button>
            <button class="secondary" id="saveDraft" type="button">Save Draft</button>
            <button class="secondary" data-toggle="session-memory" type="button">Session Memory</button>
            <button class="secondary" data-toggle="global-memory" type="button">Global Memory</button>
            <button class="secondary" data-toggle="ui-control" type="button">UI Control</button>
            <button class="danger" id="cancelActiveTask" type="button">Cancel</button>
          </div>
        </form>
        <div class="meta" id="composerMeta"></div>
        <div class="toast" id="toast"></div>
      </section>
    </main>
    <aside class="monitor">
      <section class="section">
        <h2>Tasks</h2>
        <div class="scroll-list" id="tasks"><p class="empty">No task progress has streamed yet.</p></div>
      </section>
      <section class="section">
        <h2>Approvals</h2>
        <div class="scroll-list" id="approvals"><p class="empty">No approval prompts are waiting.</p></div>
      </section>
      <section class="section">
        <h2>Scheduler</h2>
        <div class="scroll-list" id="schedulerPanel"><p class="empty">No scheduler state yet.</p></div>
      </section>
      <section class="section">
        <h2>Context Packs</h2>
        <div class="scroll-list" id="contextPacks"><p class="empty">No context packs for this workspace.</p></div>
      </section>
      <section class="section">
        <h2>Commands</h2>
        <div class="scroll-list" id="commands"><p class="empty">No remote commands yet.</p></div>
      </section>
    </aside>
  </div>
  <script>
    let pairingToken = new URLSearchParams(location.hash.slice(1)).get("pair")
      || new URLSearchParams(location.hash.slice(1)).get("token")
      || new URLSearchParams(location.search).get("pair")
      || new URLSearchParams(location.search).get("token")
      || "";
    let latestSnapshot = null;
    let selectedSessionId = "";
    const connection = document.getElementById("connection");
    const remotePromptForm = document.getElementById("remotePromptForm");
    const remotePrompt = document.getElementById("remotePrompt");
    const shellSessions = document.getElementById("shellSessions");
    const runtimePanel = document.getElementById("runtimePanel");
    const sessionHeader = document.getElementById("sessionHeader");
    const conversation = document.getElementById("conversation");
    const providerSelect = document.getElementById("providerSelect");
    const modelInput = document.getElementById("modelInput");
    const modeSelect = document.getElementById("modeSelect");
    const composerMeta = document.getElementById("composerMeta");
    const tasks = document.getElementById("tasks");
    const approvals = document.getElementById("approvals");
    const schedulerPanel = document.getElementById("schedulerPanel");
    const contextPacks = document.getElementById("contextPacks");
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

    function selectedShell() {
      return latestSnapshot?.shell || null;
    }

    function selectedSession(shell = selectedShell()) {
      if (!shell?.sessions?.length) return null;
      return shell.sessions.find((session) => session.id === selectedSessionId)
        || shell.sessions.find((session) => session.id === shell.activeSessionId)
        || shell.sessions[0];
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

    function button(command, label, extra = "", className = "secondary") {
      return `<button class="${className}" data-command="${escapeHtml(command)}" ${extra} type="button">${escapeHtml(label)}</button>`;
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
          ${item.sessionId ? `<div>session: ${escapeHtml(item.sessionId)}</div>` : ""}
          ${item.targetPreview ? `<div>${escapeHtml(item.targetPreview)}</div>` : ""}
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

    function renderTasks(items) {
      if (!items.length) {
        tasks.innerHTML = '<p class="empty">No task progress has streamed yet.</p>';
        return;
      }

      tasks.innerHTML = items.map((session) => {
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

    function renderShellSessions(shell) {
      if (!shell?.sessions?.length) {
        shellSessions.innerHTML = '<p class="empty">No desktop sessions yet.</p>';
        return;
      }

      const active = selectedSession(shell);
      selectedSessionId = active?.id || "";
      shellSessions.innerHTML = shell.sessions.map((session) => `
        <button class="item ${session.id === selectedSessionId ? "active" : ""}" data-select-session="${escapeHtml(session.id)}" type="button">
          <strong>${escapeHtml(session.title)}</strong>
          <div class="meta">
            <span class="pill">${escapeHtml(session.status)}</span>
            <span>${escapeHtml(session.provider)} / ${escapeHtml(session.model)}</span>
            ${session.pinnedAt ? '<span class="pill good">pinned</span>' : ""}
          </div>
          <div class="meta">${escapeHtml(session.workspace || "No workspace")}</div>
        </button>
      `).join("");
    }

    function renderRuntime(shell) {
      const runtime = shell?.runtime;
      if (!runtime) {
        runtimePanel.innerHTML = '<p class="empty">No runtime snapshot yet.</p>';
        return;
      }

      runtimePanel.innerHTML = `
        <div class="panel">
          <div class="meta">
            <span class="pill ${runtime.hasAnyProvider ? "good" : "bad"}">${runtime.hasAnyProvider ? "provider ready" : "provider missing"}</span>
            <span class="pill">${escapeHtml(runtime.mode || "mode unknown")}</span>
            ${runtime.loading ? '<span class="pill">loading</span>' : ""}
          </div>
          ${runtime.error ? `<div class="event">${escapeHtml(runtime.error)}</div>` : ""}
          <div class="stack">
            ${(runtime.providerStatuses || []).map((provider) => `
              <div class="meta">
                <span class="pill ${provider.available ? "good" : "bad"}">${escapeHtml(provider.provider)}</span>
                <span>${escapeHtml(provider.available ? "configured" : provider.reason || "not configured")}</span>
              </div>
            `).join("")}
          </div>
          <div class="meta">
            <span class="pill ${runtime.uiControl?.available ? "good" : "bad"}">UI control</span>
            <span>${escapeHtml(runtime.uiControl?.reason || (runtime.uiControl?.available ? "available" : "unavailable"))}</span>
          </div>
          <div class="meta">
            <span class="pill ${runtime.webSearch?.available ? "good" : "bad"}">web search</span>
            <span>${escapeHtml(runtime.webSearch?.reason || (runtime.webSearch?.available ? "available" : "unavailable"))}</span>
          </div>
        </div>
      `;
    }

    function renderSessionHeader(shell) {
      const session = selectedSession(shell);
      if (!session) {
        sessionHeader.innerHTML = '<p class="empty">Select or create a session.</p>';
        return;
      }

      sessionHeader.innerHTML = `
        <div class="row">
          <input id="sessionTitle" value="${escapeHtml(session.title)}" aria-label="Session title">
          <button class="secondary" id="saveTitle" type="button">Rename</button>
          ${button("pin-session", session.pinnedAt ? "Unpin" : "Pin", `data-session-id="${escapeHtml(session.id)}" ${session.canPin ? "" : "disabled"}`)}
          ${button("branch-session", "Branch", `data-session-id="${escapeHtml(session.id)}" ${session.canBranch ? "" : "disabled"}`)}
          ${button("duplicate-session", "Duplicate", `data-session-id="${escapeHtml(session.id)}" ${session.canDuplicate ? "" : "disabled"}`)}
          ${button("archive-session", "Archive", `data-session-id="${escapeHtml(session.id)}" ${session.canArchive ? "" : "disabled"}`)}
          ${button("delete-session", "Delete", `data-session-id="${escapeHtml(session.id)}" ${session.canDelete ? "" : "disabled"}`, "danger")}
        </div>
        <div class="meta">
          <span class="pill">${escapeHtml(session.status)}</span>
          <span class="pill">${escapeHtml(session.effectiveMode)}</span>
          <span>${escapeHtml(session.workspace || "No workspace")}</span>
          ${(session.tags || []).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}
        </div>
        <div class="row">
          <input id="tagInput" value="${escapeHtml((session.tags || []).join(", "))}" aria-label="Tags" placeholder="tag, tag">
          <button class="secondary" id="saveTags" type="button">Save Tags</button>
          ${button("clear-session-history", "Clear History", `data-session-id="${escapeHtml(session.id)}"`)}
        </div>
      `;
    }

    function renderConversation(shell) {
      if (!shell?.visibleMessages?.length) {
        conversation.innerHTML = '<p class="empty">No conversation messages yet.</p>';
        return;
      }

      conversation.innerHTML = shell.visibleMessages.map((message) => `
        <article class="message ${escapeHtml(message.role)}">
          <div class="meta">
            <span class="pill">${escapeHtml(message.role)}</span>
            ${message.taskId ? `<span>${escapeHtml(message.taskId)}</span>` : ""}
            ${message.createdAt ? `<span>${age(message.createdAt)}</span>` : ""}
          </div>
          <div class="content">${escapeHtml(message.content)}</div>
          ${(message.attachments || []).length ? `<div class="meta">${message.attachments.map((attachment) => `<span class="pill">${escapeHtml(attachment.kind)}:${escapeHtml(attachment.name)}</span>`).join("")}</div>` : ""}
          ${message.source ? `
            <div class="stack">
              ${(message.source.entries || []).slice(-6).map((entry) => `<div class="trace"><strong>${escapeHtml(entry.label)}</strong><div>${escapeHtml(entry.detail)}</div></div>`).join("")}
              ${(message.source.timeline || []).slice(-6).map((entry) => `<div class="trace"><strong>${escapeHtml(entry.label)}</strong><div>${escapeHtml(entry.detail)}</div></div>`).join("")}
            </div>
          ` : ""}
          <div class="actions">
            <button class="secondary" data-message-action="retry" data-message-id="${escapeHtml(message.id)}" data-task="${escapeHtml(message.taskId || "")}" ${message.actions?.canRetry && message.taskId ? "" : "disabled"}>Retry</button>
            <button class="secondary" data-message-action="continue" data-message-id="${escapeHtml(message.id)}" data-task="${escapeHtml(message.taskId || "")}" ${message.actions?.canContinue && message.taskId ? "" : "disabled"}>Continue</button>
            <button class="secondary" data-message-action="save-message-context-pack" data-message-id="${escapeHtml(message.id)}" ${message.actions?.canSaveAsContextPack ? "" : "disabled"}>Save Pack</button>
            <button class="secondary" data-message-action="${message.actions?.isSpeaking ? "stop-speaking" : "speak-message"}" data-message-id="${escapeHtml(message.id)}" ${message.actions?.canSpeak || message.actions?.isSpeaking ? "" : "disabled"}>${message.actions?.isSpeaking ? "Stop" : "Speak"}</button>
          </div>
        </article>
      `).join("");
    }

    function renderComposer(shell) {
      const composer = shell?.composer;
      const session = selectedSession(shell);
      if (!composer || !session) return;

      if (document.activeElement !== remotePrompt) {
        remotePrompt.value = composer.draft || "";
      }
      providerSelect.innerHTML = (composer.chooserProviders || []).map((provider) => `
        <option value="${escapeHtml(provider)}" ${provider === composer.provider ? "selected" : ""}>${escapeHtml(provider)}</option>
      `).join("");
      if (document.activeElement !== modelInput) {
        modelInput.value = composer.model || "";
      }
      modeSelect.value = session.mode || "";
      composerMeta.innerHTML = `
        <span class="pill ${composer.canSend ? "good" : "bad"}">${composer.canSend ? "ready" : "blocked"}</span>
        <span>${escapeHtml(composer.sendDisabledReason || composer.workspaceLabel || "No workspace")}</span>
        <span class="pill ${composer.sessionMemoryEnabled ? "good" : ""}">session memory</span>
        <span class="pill ${composer.globalMemoryEnabled ? "good" : ""}">global memory</span>
        <span class="pill ${composer.uiControlEnabled ? "good" : ""}">UI control</span>
        ${(composer.attachments || []).map((attachment) => `<span class="pill">${escapeHtml(attachment.kind)}:${escapeHtml(attachment.name)} <button data-remove-attachment="${escapeHtml(attachment.id)}" type="button">x</button></span>`).join("")}
        ${(shell.promptHistory || []).slice(-6).reverse().map((prompt) => `<button class="secondary" data-history-prompt="${escapeHtml(prompt)}" type="button">${escapeHtml(prompt.slice(0, 36))}</button>`).join("")}
      `;
    }

    function renderScheduler(shell) {
      const scheduler = shell?.scheduler;
      if (!scheduler) {
        schedulerPanel.innerHTML = '<p class="empty">No scheduler state yet.</p>';
        return;
      }
      const jobs = scheduler.jobs || [];
      const runs = scheduler.runs || [];
      schedulerPanel.innerHTML = `
        <div class="meta">
          <span class="pill">${escapeHtml(scheduler.workspaceRoot || "No workspace")}</span>
          ${scheduler.loading ? '<span class="pill">loading</span>' : ""}
          ${scheduler.error ? `<span class="pill bad">${escapeHtml(scheduler.error)}</span>` : ""}
        </div>
        ${jobs.length ? jobs.slice(0, 8).map((job) => `
          <div class="event">
            <strong>${escapeHtml(job.name)}</strong>
            <div class="meta"><span class="pill">${escapeHtml(job.status)}</span><span>${escapeHtml(job.schedule)}</span></div>
            <div>${escapeHtml(job.promptPreview || "")}</div>
            <div class="actions">
              ${button("scheduler-trigger", "Run", `data-job-id="${escapeHtml(job.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`)}
              ${job.status === "paused"
                ? button("scheduler-resume", "Resume", `data-job-id="${escapeHtml(job.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`)
                : button("scheduler-pause", "Pause", `data-job-id="${escapeHtml(job.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`)}
              ${button("scheduler-delete", "Delete", `data-job-id="${escapeHtml(job.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`, "danger")}
            </div>
          </div>
        `).join("") : '<p class="empty">No scheduler jobs.</p>'}
        ${runs.length ? runs.slice(0, 8).map((run) => `
          <div class="event">
            <strong>${escapeHtml(run.status)}</strong>
            <div class="meta"><span>${escapeHtml(run.id)}</span><span>${age(run.updatedAt)}</span></div>
            ${run.error ? `<div>${escapeHtml(run.error)}</div>` : ""}
            <div class="actions">
              ${button("scheduler-retry-run", "Retry", `data-run-id="${escapeHtml(run.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`)}
              ${button("scheduler-cancel-run", "Cancel", `data-run-id="${escapeHtml(run.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`, "danger")}
            </div>
          </div>
        `).join("") : ""}
      `;
    }

    function renderContextPacks(shell) {
      const packs = shell?.contextPacks || [];
      const session = selectedSession(shell);
      if (!packs.length || !session) {
        contextPacks.innerHTML = '<p class="empty">No context packs for this workspace.</p>';
        return;
      }

      contextPacks.innerHTML = packs.map((pack) => `
        <div class="event">
          <strong>${escapeHtml(pack.name)}</strong>
          <div>${escapeHtml(pack.promptPreview || pack.instructionsPreview || "")}</div>
          <div class="meta">
            <span class="pill">${pack.attachmentCount} attachments</span>
            ${pack.matched ? '<span class="pill good">matched</span>' : ""}
          </div>
          <div class="actions">
            ${button("apply-context-pack", "Apply", `data-session-id="${escapeHtml(session.id)}" data-context-pack-id="${escapeHtml(pack.id)}"`)}
            ${button("delete-context-pack", "Delete", `data-context-pack-id="${escapeHtml(pack.id)}"`, "danger")}
          </div>
        </div>
      `).join("");
    }

    function renderShell(shell) {
      renderShellSessions(shell);
      renderRuntime(shell);
      renderSessionHeader(shell);
      renderConversation(shell);
      renderComposer(shell);
      renderScheduler(shell);
      renderContextPacks(shell);
    }

    function render(snapshot) {
      latestSnapshot = snapshot;
      connection.textContent = snapshot.enabled ? `Live (${snapshot.sessions.length})` : "Disabled";
      renderShell(snapshot.shell || null);
      renderTasks(snapshot.sessions || []);
      renderCommands(snapshot.commands || []);
      renderApprovals(snapshot.approvalPrompts || []);
    }

    remotePromptForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const prompt = remotePrompt.value.trim();
      if (!prompt) return;
      remotePrompt.value = "";
      const session = selectedSession();
      void sendCommand({
        kind: "follow-up",
        sessionId: session?.id,
        prompt
      }).catch((error) => { toast.textContent = error.message; });
    });

    tasks.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-kind]");
      if (!button) return;
      void sendCommand({
        kind: button.dataset.kind,
        taskId: button.dataset.task
      }).catch((error) => { toast.textContent = error.message; });
    });

    tasks.addEventListener("submit", (event) => {
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

    shellSessions.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-select-session]");
      if (!button) return;
      selectedSessionId = button.dataset.selectSession;
      render(latestSnapshot);
      void sendCommand({ kind: "activate-session", sessionId: selectedSessionId })
        .catch((error) => { toast.textContent = error.message; });
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

    document.addEventListener("click", (event) => {
      const commandButton = event.target.closest("button[data-command]");
      if (commandButton) {
        void sendCommand({
          kind: commandButton.dataset.command,
          sessionId: commandButton.dataset.sessionId,
          jobId: commandButton.dataset.jobId,
          runId: commandButton.dataset.runId,
          contextPackId: commandButton.dataset.contextPackId,
          workspace: commandButton.dataset.workspace
        }).catch((error) => { toast.textContent = error.message; });
        return;
      }

      const selected = selectedSession();
      if (!selected) return;

      if (event.target.closest("#saveTitle")) {
        const title = document.getElementById("sessionTitle")?.value || "";
        void sendCommand({ kind: "rename-session", sessionId: selected.id, title })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }

      if (event.target.closest("#saveTags")) {
        const tags = (document.getElementById("tagInput")?.value || "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
        void sendCommand({ kind: "tag-session", sessionId: selected.id, tags })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }

      if (event.target.closest("#saveDraft")) {
        void sendCommand({ kind: "update-draft", sessionId: selected.id, prompt: remotePrompt.value })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }

      if (event.target.closest("#cancelActiveTask")) {
        const taskId = selected.runningTaskId;
        if (taskId) {
          void sendCommand({ kind: "cancel", taskId }).catch((error) => { toast.textContent = error.message; });
        }
        return;
      }

      const toggle = event.target.closest("button[data-toggle]");
      if (toggle) {
        const composer = selectedShell()?.composer;
        const toggleKind = toggle.dataset.toggle;
        const command = toggleKind === "session-memory"
          ? { kind: "set-session-memory", enabled: !composer?.sessionMemoryEnabled }
          : toggleKind === "global-memory"
            ? { kind: "set-global-memory", enabled: !composer?.globalMemoryEnabled }
            : { kind: "set-ui-control", enabled: !composer?.uiControlEnabled };
        void sendCommand({ ...command, sessionId: selected.id }).catch((error) => { toast.textContent = error.message; });
        return;
      }

      const attachment = event.target.closest("button[data-remove-attachment]");
      if (attachment) {
        void sendCommand({ kind: "remove-attachment", sessionId: selected.id, attachmentId: attachment.dataset.removeAttachment })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }

      const historyPrompt = event.target.closest("button[data-history-prompt]");
      if (historyPrompt) {
        remotePrompt.value = historyPrompt.dataset.historyPrompt || "";
      }
    });

    document.addEventListener("change", (event) => {
      const selected = selectedSession();
      if (!selected) return;

      if (event.target === providerSelect || event.target === modelInput) {
        const provider = providerSelect.value;
        const model = modelInput.value.trim();
        if (provider && model) {
          void sendCommand({ kind: "set-session-model", sessionId: selected.id, provider, model })
            .catch((error) => { toast.textContent = error.message; });
        }
        return;
      }

      if (event.target === modeSelect) {
        void sendCommand({ kind: "set-session-mode", sessionId: selected.id, mode: modeSelect.value })
          .catch((error) => { toast.textContent = error.message; });
      }
    });

    conversation.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-message-action]");
      if (!button) return;
      const session = selectedSession();
      if (!session) return;
      const action = button.dataset.messageAction;
      if (action === "retry" || action === "continue") {
        void sendCommand({ kind: action, taskId: button.dataset.task })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }
      void sendCommand({
        kind: action,
        sessionId: session.id,
        messageId: button.dataset.messageId
      }).catch((error) => { toast.textContent = error.message; });
    });

    document.getElementById("createSession").addEventListener("click", () => {
      void sendCommand({ kind: "create-session", workspace: selectedShell()?.composer?.workspace })
        .catch((error) => { toast.textContent = error.message; });
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

    fn command_request(kind: &str) -> RemoteCommandRequest {
        RemoteCommandRequest {
            kind: kind.to_string(),
            task_id: None,
            session_id: None,
            prompt: None,
            decision: None,
            prompt_id: None,
            title: None,
            tags: None,
            provider: None,
            model: None,
            mode: None,
            profile: None,
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
            decision: None,
            prompt_id: None,
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
    fn approval_decisions_require_prompt_id() {
        let result = normalize_command(RemoteCommandRequest {
            kind: "approval-decision".to_string(),
            task_id: Some("task-1".to_string()),
            session_id: None,
            prompt: None,
            decision: Some("approve".to_string()),
            prompt_id: None,
            ..command_request("approval-decision")
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
            session_id: None,
            prompt: None,
            decision: Some("approve".to_string()),
            prompt_id: Some("approval-1".to_string()),
            ..command_request("approval-decision")
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
