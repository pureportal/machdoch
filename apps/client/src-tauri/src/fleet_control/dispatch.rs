use machdoch_fleet_protocol::{CommandReceipt, HostErrorCode, ProductCommand};
use std::time::Duration;
use tauri::{Emitter, Manager};

use crate::desktop_task::{request_desktop_task_cancel, DesktopTaskCancelMap};

use super::{
    commands::normalize_command,
    state::{RecordCommandError, RecordCommandOutcome},
    FleetControlState, FLEET_CONTROL_COMMAND_EVENT,
};

pub(super) enum FleetCommandDispatchError {
    InvalidRequest(String),
    Conflict(String),
    Unavailable(String),
}

pub(super) fn dispatch_fleet_command(
    control_state: &FleetControlState,
    app_handle: &tauri::AppHandle,
    mut request: ProductCommand,
) -> Result<CommandReceipt, FleetCommandDispatchError> {
    if request.kind.is_workspace_command() {
        return Err(FleetCommandDispatchError::Unavailable(
            "Project management requires a headless Fleet host running machdoch fleet service."
                .to_string(),
        ));
    }
    if request.kind.as_str() == "set-session-workspace" {
        let workspace = request.workspace.as_deref().ok_or_else(|| {
            FleetCommandDispatchError::InvalidRequest("Workspace path is required.".to_string())
        })?;
        request.workspace = Some(
            crate::runtime_snapshot::resolve_workspace_root_path(workspace)
                .map_err(FleetCommandDispatchError::InvalidRequest)?
                .display()
                .to_string(),
        );
    }
    let mut event =
        normalize_command(request).map_err(FleetCommandDispatchError::InvalidRequest)?;
    if control_state
        .command_is_duplicate(&event)
        .map_err(FleetCommandDispatchError::from)?
    {
        control_state
            .wait_for_command_completion(&event.command_id, Duration::from_secs(30))
            .map_err(FleetCommandDispatchError::from)?;
        return Ok(CommandReceipt {
            command_id: event.command_id,
            duplicate: true,
        });
    }
    control_state
        .validate_command_target(&event)
        .map_err(FleetCommandDispatchError::from)?;
    if event.kind == "add-workspace" {
        crate::runtime_snapshot::resolve_workspace_root_path(event.workspace.as_deref().unwrap())
            .map_err(FleetCommandDispatchError::InvalidRequest)?;
    }
    if event.kind == "relink-workspace" {
        crate::runtime_snapshot::resolve_workspace_root_path(
            event.destination_workspace.as_deref().unwrap(),
        )
        .map_err(FleetCommandDispatchError::InvalidRequest)?;
    }

    if event.kind == "add-context-attachments" {
        super::context_attachments::validate(app_handle, &event)
            .map_err(FleetCommandDispatchError::InvalidRequest)?;
    }

    if matches!(
        event.kind.as_str(),
        "save-context-pack" | "import-context-packs"
    ) {
        super::context_packs::prepare(app_handle, &mut event)
            .map_err(FleetCommandDispatchError::InvalidRequest)?;
    }

    let outcome = control_state
        .record_command(&event)
        .map_err(FleetCommandDispatchError::from)?;

    if outcome == RecordCommandOutcome::Duplicate {
        control_state
            .wait_for_command_completion(&event.command_id, Duration::from_secs(30))
            .map_err(FleetCommandDispatchError::from)?;
        return Ok(CommandReceipt {
            command_id: event.command_id,
            duplicate: true,
        });
    }

    if event.kind == "cancel" {
        if let Some(task_id) = event.task_id.as_deref() {
            let cancel_state = app_handle.state::<DesktopTaskCancelMap>();
            app_handle
                .state::<crate::desktop_task::ralph_host_recovery::RalphHostRecoveryState>()
                .remove_task(task_id, || {
                    request_desktop_task_cancel(&cancel_state, task_id)
                })
                .map_err(FleetCommandDispatchError::Unavailable)?;
        }
    }

    app_handle.emit(FLEET_CONTROL_COMMAND_EVENT, event.clone()).map_err(|error| FleetCommandDispatchError::Unavailable(format!("The command is queued, but the device could not receive its notification: {error}. Refresh the device before repeating the action.")))?;
    control_state
        .wait_for_command_completion(&event.command_id, Duration::from_secs(30))
        .map_err(FleetCommandDispatchError::from)?;

    Ok(CommandReceipt {
        command_id: event.command_id,
        duplicate: false,
    })
}

impl From<RecordCommandError> for FleetCommandDispatchError {
    fn from(error: RecordCommandError) -> Self {
        match error {
            RecordCommandError::CommandIdConflict => Self::Conflict(
                "The command id was already used for a different command.".to_string(),
            ),
            RecordCommandError::Unavailable(message) => Self::Unavailable(message),
        }
    }
}

pub(super) fn dispatch_error_code(error: &FleetCommandDispatchError) -> HostErrorCode {
    match error {
        FleetCommandDispatchError::InvalidRequest(_) => HostErrorCode::InvalidRequest,
        FleetCommandDispatchError::Conflict(_) => HostErrorCode::Conflict,
        FleetCommandDispatchError::Unavailable(_) => HostErrorCode::Unavailable,
    }
}

pub(super) fn dispatch_error_message(error: FleetCommandDispatchError) -> String {
    match error {
        FleetCommandDispatchError::InvalidRequest(message)
        | FleetCommandDispatchError::Conflict(message)
        | FleetCommandDispatchError::Unavailable(message) => message,
    }
}
