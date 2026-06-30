use std::{
    collections::VecDeque,
    net::{Ipv4Addr, SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
};

use serde_json::Value;

use super::{
    commands::{create_command_record, truncate_chars},
    config::{
        ensure_remote_control_port_available, load_remote_control_config_file,
        validate_remote_control_port, write_remote_control_config_file,
    },
    create_qr_svg, create_secure_token, create_status_locked, detect_lan_ip, push_bounded,
    sanitize::sanitize_shell_snapshot,
    session::create_remote_web_session_token,
    string_field,
    web::run_http_server,
    RemoteControlCommandEvent, RemoteControlInner, RemoteControlServerInfo, RemoteControlShared,
    RemoteControlState, RemoteControlStatus, RemoteLogEntry, RemoteShellSnapshot,
    RemoteTaskSession, RemoteTimelineEntry, REMOTE_CONTROL_CONFIG_VERSION,
};
use super::{
    MAX_COMMAND_ENTRIES, MAX_COMMAND_TEXT_CHARS, MAX_LOG_ENTRIES, MAX_SESSIONS,
    MAX_TIMELINE_ENTRIES,
};

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
    pub(super) fn status(&self) -> Result<RemoteControlStatus, String> {
        self.ensure_config_loaded()?;

        let inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect remote control state.".to_string())?;

        Ok(create_status_locked(&inner))
    }

    pub(super) fn enable(
        &self,
        app_handle: tauri::AppHandle,
    ) -> Result<RemoteControlStatus, String> {
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
        let started_at = super::now_millis();
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

    pub(super) fn disable(&self) -> Result<RemoteControlStatus, String> {
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

    pub(super) fn record_progress(&self, task_id: &str, progress: &Value, timestamp: u64) {
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

    pub(super) fn record_command(&self, event: &RemoteControlCommandEvent) {
        let Ok(mut inner) = self.shared.inner.lock() else {
            return;
        };

        push_bounded(
            &mut inner.commands,
            create_command_record(event),
            MAX_COMMAND_ENTRIES,
        );
        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.updates.notify_all();
    }

    pub(super) fn update_shell_snapshot(
        &self,
        snapshot: RemoteShellSnapshot,
    ) -> Result<(), String> {
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

    pub(super) fn create_web_session(&self, user_agent: Option<&str>) -> Result<String, String> {
        self.ensure_config_loaded()?;

        create_remote_web_session_token(&self.shared, user_agent)
    }

    pub(super) fn display_url(&self) -> Result<String, String> {
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

    pub(super) fn set_port(
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

    pub(super) fn forget_pairings(&self) -> Result<RemoteControlStatus, String> {
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

    pub(super) fn enable_if_configured(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
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
