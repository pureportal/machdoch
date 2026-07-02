use std::{
    net::{Ipv4Addr, SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
};

use serde_json::Value;

use super::MAX_COMMAND_ENTRIES;
use super::{
    commands::create_command_record,
    config::{ensure_remote_control_port_available, validate_remote_control_port},
    create_qr_svg, create_secure_token, detect_lan_ip, push_bounded,
    sanitize::sanitize_shell_snapshot,
    session::create_remote_web_session_token,
    state_progress::record_progress_update,
    state_store::persist_config_locked,
    status::create_status_locked,
    web::run_http_server,
    RemoteControlCommandEvent, RemoteControlInner, RemoteControlServerInfo, RemoteControlShared,
    RemoteControlState, RemoteControlStatus, RemoteShellSnapshot,
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
        let started_at = super::now_millis();
        let shutdown = Arc::new(AtomicBool::new(false));
        let server = create_server_info(port, token, started_at, shutdown.clone())?;

        {
            let mut inner = self
                .shared
                .inner
                .lock()
                .map_err(|_| "Unable to update remote control state.".to_string())?;

            if inner.server.is_some() {
                if !inner.config.enabled {
                    inner.config.enabled = true;
                    persist_config_locked(&mut inner)?;
                }
                return Ok(create_status_locked(&inner));
            }

            inner.config.enabled = true;
            persist_config_locked(&mut inner)?;
            inner.server = Some(server);
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
            persist_config_locked(&mut inner)?;
            changed = true;
        }

        if changed {
            inner.event_id = inner.event_id.saturating_add(1);
            self.shared.updates.notify_all();
        }

        Ok(create_status_locked(&inner))
    }

    pub(super) fn record_progress(&self, task_id: &str, progress: &Value, timestamp: u64) {
        record_progress_update(&self.shared, task_id, progress, timestamp);
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
            persist_config_locked(&mut inner)?;

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
        persist_config_locked(&mut inner)?;
        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.updates.notify_all();

        Ok(create_status_locked(&inner))
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

fn create_server_info(
    port: u16,
    token: String,
    started_at: u64,
    shutdown: Arc<AtomicBool>,
) -> Result<RemoteControlServerInfo, String> {
    let local_url = format!("http://127.0.0.1:{port}/#pair={token}");
    let lan_url = detect_lan_ip().map(|ip| format!("http://{ip}:{port}/#pair={token}"));
    let display_url = lan_url.clone().unwrap_or_else(|| local_url.clone());
    let qr_svg = create_qr_svg(&display_url)?;
    let bind_address = format!("0.0.0.0:{port}");

    Ok(RemoteControlServerInfo {
        token,
        port,
        local_url,
        lan_url,
        display_url,
        qr_svg,
        started_at,
        bind_address,
        shutdown,
    })
}
