use machdoch_fleet_protocol::{CommandReceipt, HostErrorCode, ProductCommand};
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
    request: ProductCommand,
) -> Result<CommandReceipt, FleetCommandDispatchError> {
    let event = match normalize_command(request) {
        Ok(event) => event,
        Err(error) => return Err(FleetCommandDispatchError::InvalidRequest(error)),
    };

    let outcome = match control_state.record_command(&event) {
        Ok(outcome) => outcome,
        Err(RecordCommandError::CommandIdConflict) => {
            return Err(FleetCommandDispatchError::Conflict(
                "The command id was already used for a different command.".to_string(),
            ));
        }
        Err(RecordCommandError::Unavailable(error)) => {
            return Err(FleetCommandDispatchError::Unavailable(error));
        }
    };

    if outcome == RecordCommandOutcome::Duplicate {
        return Ok(CommandReceipt {
            command_id: event.command_id,
            duplicate: true,
        });
    }

    if event.kind == "cancel" {
        if let Some(task_id) = event.task_id.as_deref() {
            let cancel_state = app_handle.state::<DesktopTaskCancelMap>();
            request_desktop_task_cancel(&cancel_state, task_id);
        }
    }

    let _ = app_handle.emit(FLEET_CONTROL_COMMAND_EVENT, event.clone());

    Ok(CommandReceipt {
        command_id: event.command_id,
        duplicate: false,
    })
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
