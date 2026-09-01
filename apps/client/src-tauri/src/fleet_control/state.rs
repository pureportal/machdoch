use std::sync::{Arc, Mutex};

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
            }),
        }
    }
}

impl FleetControlState {
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

        if let Some(existing) = inner
            .pending_commands
            .iter()
            .find(|command| command.command_id == event.command_id)
        {
            return if command_payloads_match(existing, event) {
                Ok(RecordCommandOutcome::Duplicate)
            } else {
                Err(RecordCommandError::CommandIdConflict)
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
                Err(RecordCommandError::CommandIdConflict)
            };
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

    pub(super) fn acknowledge_command(&self, command_id: &str) -> Result<bool, String> {
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
        Ok(true)
    }

    pub(super) fn update_shell_snapshot(&self, snapshot: FleetShellSnapshot) -> Result<(), String> {
        self.ensure_state_loaded()?;
        let snapshot = sanitize_shell_snapshot(snapshot)?;
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
        inner.event_id = inner.event_id.saturating_add(1);
        Ok(())
    }
}
