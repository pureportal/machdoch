use std::{
    net::{Ipv4Addr, SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
};

use serde_json::Value;

use super::{
    commands::{command_payload_hash, command_payloads_match, create_command_record},
    config::{ensure_remote_control_port_available, validate_remote_control_port},
    now_millis,
    pairing::{create_secure_token, create_server_info},
    push_bounded,
    sanitize::sanitize_shell_snapshot,
    session::create_remote_web_session_token,
    state_progress::record_progress_update,
    state_store::persist_config_locked,
    status::create_status_locked,
    web::run_http_server,
    CompletedRemoteCommandReceipt, RemoteControlCommandEvent, RemoteControlInner,
    RemoteControlShared, RemoteControlState, RemoteControlStatus, RemoteShellSnapshot,
};
use super::{MAX_COMMAND_ENTRIES, MAX_COMPLETED_COMMAND_ENTRIES, MAX_PENDING_COMMAND_ENTRIES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RecordCommandOutcome {
    Recorded,
    Duplicate,
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

    pub(super) fn record_command(
        &self,
        event: &RemoteControlCommandEvent,
    ) -> Result<RecordCommandOutcome, String> {
        self.ensure_config_loaded()?;
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to record the remote command.".to_string())?;

        if let Some(existing) = inner
            .pending_commands
            .iter()
            .find(|command| command.command_id == event.command_id)
        {
            return if command_payloads_match(existing, event) {
                Ok(RecordCommandOutcome::Duplicate)
            } else {
                Err(
                    "MACHDOCH_REMOTE_COMMAND_ID_CONFLICT:The command id was already used for a different command."
                        .to_string(),
                )
            };
        }

        if let Some(existing) = inner
            .completed_commands
            .iter()
            .find(|command| command.command_id == event.command_id)
        {
            return if existing.payload_hash == command_payload_hash(event) {
                Ok(RecordCommandOutcome::Duplicate)
            } else {
                Err(
                    "MACHDOCH_REMOTE_COMMAND_ID_CONFLICT:The command id was already used for a different command."
                        .to_string(),
                )
            };
        }

        if inner.pending_commands.len() >= MAX_PENDING_COMMAND_ENTRIES {
            return Err(
                "Mission Control has too many unacknowledged commands; retry after they are processed."
                    .to_string(),
            );
        }

        inner.pending_commands.push_back(event.clone());
        inner.config.pending_commands = inner.pending_commands.iter().cloned().collect();
        if let Err(error) = persist_config_locked(&mut inner) {
            inner.pending_commands.pop_back();
            inner.config.pending_commands = inner.pending_commands.iter().cloned().collect();
            return Err(error);
        }
        push_bounded(
            &mut inner.commands,
            create_command_record(event),
            MAX_COMMAND_ENTRIES,
        );
        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.updates.notify_all();
        Ok(RecordCommandOutcome::Recorded)
    }

    pub(super) fn pending_commands(&self) -> Result<Vec<RemoteControlCommandEvent>, String> {
        self.ensure_config_loaded()?;
        let inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect pending remote commands.".to_string())?;

        Ok(inner.pending_commands.iter().cloned().collect())
    }

    pub(super) fn acknowledge_command(&self, command_id: &str) -> Result<bool, String> {
        self.ensure_config_loaded()?;
        let command_id = command_id.trim();

        if command_id.is_empty() {
            return Err("Expected a non-empty remote command id.".to_string());
        }

        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to acknowledge the remote command.".to_string())?;
        let removed_index = inner
            .pending_commands
            .iter()
            .position(|command| command.command_id == command_id);
        let Some(removed_index) = removed_index else {
            return Ok(false);
        };
        let Some(removed_command) = inner.pending_commands.remove(removed_index) else {
            return Ok(false);
        };
        let previous_completed_commands = inner.completed_commands.clone();
        inner
            .completed_commands
            .push_back(CompletedRemoteCommandReceipt {
                command_id: removed_command.command_id.clone(),
                payload_hash: command_payload_hash(&removed_command),
                completed_at: now_millis(),
            });
        while inner.completed_commands.len() > MAX_COMPLETED_COMMAND_ENTRIES {
            inner.completed_commands.pop_front();
        }
        inner.config.pending_commands = inner.pending_commands.iter().cloned().collect();
        inner.config.completed_commands = inner.completed_commands.iter().cloned().collect();

        if let Err(error) = persist_config_locked(&mut inner) {
            inner
                .pending_commands
                .insert(removed_index, removed_command);
            inner.completed_commands = previous_completed_commands;
            inner.config.pending_commands = inner.pending_commands.iter().cloned().collect();
            inner.config.completed_commands = inner.completed_commands.iter().cloned().collect();
            return Err(error);
        }

        let removed = true;

        if removed {
            inner.event_id = inner.event_id.saturating_add(1);
            self.shared.updates.notify_all();
        }

        Ok(removed)
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

        if inner
            .shell
            .as_ref()
            .is_some_and(|current| current.captured_at > snapshot.captured_at)
        {
            return Ok(());
        }

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
