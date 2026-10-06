use std::{
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

use serde_json::Value;

use super::{
    commands::{command_payload_hash, command_payloads_match, create_command_record},
    now_millis, push_bounded,
    sanitize::sanitize_shell_snapshot,
    state_progress::record_progress_update,
    state_store::persist_state_locked,
    CompletedFleetCommandReceipt, FleetControlCommandEvent, FleetControlInner, FleetControlShared,
    FleetControlState, FleetShellSnapshot, MAX_COMMAND_ENTRIES, MAX_COMPLETED_COMMAND_ENTRIES,
    MAX_PENDING_COMMAND_ENTRIES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RecordCommandOutcome {
    Recorded,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RecordCommandError {
    CommandIdConflict,
    Unavailable(String),
}

impl From<String> for RecordCommandError {
    fn from(message: String) -> Self {
        Self::Unavailable(message)
    }
}

impl Default for FleetControlState {
    fn default() -> Self {
        Self {
            shared: Arc::new(FleetControlShared {
                inner: Mutex::new(FleetControlInner::default()),
                command_completed: Condvar::new(),
            }),
        }
    }
}

impl FleetControlState {
    pub(super) fn command_is_duplicate(
        &self,
        event: &FleetControlCommandEvent,
    ) -> Result<bool, RecordCommandError> {
        self.ensure_state_loaded()
            .map_err(RecordCommandError::from)?;
        let inner = self.shared.inner.lock().map_err(|_| {
            RecordCommandError::Unavailable("Unable to inspect the Fleet command.".to_string())
        })?;
        check_command_replay(&inner, event)
    }

    pub(super) fn validate_command_target(
        &self,
        event: &FleetControlCommandEvent,
    ) -> Result<(), RecordCommandError> {
        self.ensure_state_loaded()?;
        let inner = self.shared.inner.lock().map_err(|_| {
            RecordCommandError::Unavailable("Unable to inspect the device.".to_string())
        })?;
        super::command_validation::validate_command_target(
            event,
            inner.shell.as_ref(),
            &inner.known_session_ids,
        )
        .map_err(RecordCommandError::Unavailable)
    }

    pub(super) fn wait_for_command_completion(
        &self,
        command_id: &str,
        timeout: Duration,
    ) -> Result<(), RecordCommandError> {
        self.ensure_state_loaded()?;
        let deadline = Instant::now() + timeout;
        let mut inner = self.shared.inner.lock().map_err(|_| {
            RecordCommandError::Unavailable("Unable to inspect the Fleet command.".to_string())
        })?;
        loop {
            if let Some(completed) = inner
                .completed_commands
                .iter()
                .find(|entry| entry.command_id == command_id)
            {
                return match &completed.error {
                    Some(message) => Err(RecordCommandError::Unavailable(message.clone())),
                    None => Ok(()),
                };
            }
            if !inner
                .pending_commands
                .iter()
                .any(|entry| entry.command_id == command_id)
            {
                return Err(RecordCommandError::Unavailable("The Fleet command is no longer recorded on this device. Refresh the device before repeating the action.".to_string()));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(RecordCommandError::Unavailable("The command is queued, but the device has not confirmed it yet. Refresh the device before repeating the action.".to_string()));
            }
            let (next, _) = self
                .shared
                .command_completed
                .wait_timeout(inner, remaining)
                .map_err(|_| {
                    RecordCommandError::Unavailable(
                        "Unable to wait for the Fleet command.".to_string(),
                    )
                })?;
            inner = next;
        }
    }

    pub(super) fn record_progress(&self, task_id: &str, progress: &Value, timestamp: u64) {
        if self.ensure_state_loaded().is_ok() {
            record_progress_update(&self.shared, task_id, progress, timestamp);
        }
    }

    pub(super) fn record_command(
        &self,
        event: &FleetControlCommandEvent,
    ) -> Result<RecordCommandOutcome, RecordCommandError> {
        self.ensure_state_loaded()
            .map_err(RecordCommandError::from)?;
        let mut inner = self.shared.inner.lock().map_err(|_| {
            RecordCommandError::Unavailable("Unable to record the Fleet command.".to_string())
        })?;

        if check_command_replay(&inner, event)? {
            return Ok(RecordCommandOutcome::Duplicate);
        }

        if inner.pending_commands.len() >= MAX_PENDING_COMMAND_ENTRIES {
            return Err(RecordCommandError::Unavailable(
                "Fleet Manager has too many unacknowledged commands; retry after they are processed."
                    .to_string(),
            ));
        }

        inner.pending_commands.push_back(event.clone());
        if let Err(error) = persist_state_locked(&inner) {
            inner.pending_commands.pop_back();
            return Err(RecordCommandError::Unavailable(error));
        }
        push_bounded(
            &mut inner.commands,
            create_command_record(event),
            MAX_COMMAND_ENTRIES,
        );
        inner.event_id = inner.event_id.saturating_add(1);
        Ok(RecordCommandOutcome::Recorded)
    }

    pub(super) fn pending_commands(&self) -> Result<Vec<FleetControlCommandEvent>, String> {
        self.ensure_state_loaded()?;
        let inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect pending Fleet commands.".to_string())?;

        Ok(inner.pending_commands.iter().cloned().collect())
    }

    pub(super) fn acknowledge_command(
        &self,
        command_id: &str,
        error: Option<String>,
    ) -> Result<bool, String> {
        self.ensure_state_loaded()?;
        let command_id = command_id.trim();

        if command_id.is_empty() {
            return Err("Expected a non-empty Fleet command id.".to_string());
        }

        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to acknowledge the Fleet command.".to_string())?;
        let Some(removed_index) = inner
            .pending_commands
            .iter()
            .position(|command| command.command_id == command_id)
        else {
            return Ok(false);
        };
        let Some(removed_command) = inner.pending_commands.remove(removed_index) else {
            return Ok(false);
        };
        let previous_completed_commands = inner.completed_commands.clone();
        inner
            .completed_commands
            .push_back(CompletedFleetCommandReceipt {
                command_id: removed_command.command_id.clone(),
                payload_hash: command_payload_hash(&removed_command),
                completed_at: now_millis(),
                error: error.map(|message| {
                    super::commands::truncate_chars(&message, super::MAX_FLEET_TEXT_CHARS)
                }),
            });
        while inner.completed_commands.len() > MAX_COMPLETED_COMMAND_ENTRIES {
            inner.completed_commands.pop_front();
        }

        if let Err(error) = persist_state_locked(&inner) {
            inner
                .pending_commands
                .insert(removed_index, removed_command);
            inner.completed_commands = previous_completed_commands;
            return Err(error);
        }

        inner.event_id = inner.event_id.saturating_add(1);
        self.shared.command_completed.notify_all();
        Ok(true)
    }

    pub(super) fn update_shell_snapshot(
        &self,
        snapshot: FleetShellSnapshot,
        session_ids: Vec<String>,
    ) -> Result<(), String> {
        self.ensure_state_loaded()?;
        let snapshot = sanitize_shell_snapshot(snapshot)?;
        let session_ids = super::command_validation::validate_session_ids(session_ids, &snapshot)?;
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to update the Fleet Manager product snapshot.".to_string())?;

        if inner
            .shell
            .as_ref()
            .is_some_and(|current| current.captured_at > snapshot.captured_at)
        {
            return Ok(());
        }

        inner.shell = Some(snapshot);
        inner.known_session_ids = session_ids;
        inner.event_id = inner.event_id.saturating_add(1);
        Ok(())
    }
}

fn check_command_replay(
    inner: &FleetControlInner,
    event: &FleetControlCommandEvent,
) -> Result<bool, RecordCommandError> {
    let matched = inner
        .pending_commands
        .iter()
        .find(|command| command.command_id == event.command_id)
        .map(|existing| command_payloads_match(existing, event))
        .or_else(|| {
            inner
                .completed_commands
                .iter()
                .find(|command| command.command_id == event.command_id)
                .map(|existing| existing.payload_hash == command_payload_hash(event))
        });
    match matched {
        Some(true) => Ok(true),
        Some(false) => Err(RecordCommandError::CommandIdConflict),
        None => Ok(false),
    }
}
