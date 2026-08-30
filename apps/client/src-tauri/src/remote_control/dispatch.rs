use axum::http::StatusCode;
use machdoch_fleet_protocol::{CommandReceipt, HostErrorCode, ProductCommand};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::desktop_task::{request_desktop_task_cancel, DesktopTaskCancelMap};

use super::{
    commands::normalize_command,
    state::{RecordCommandError, RecordCommandOutcome},
    RemoteControlState, REMOTE_CONTROL_COMMAND_EVENT,
};

pub(super) enum RemoteCommandDispatchError {
    InvalidRequest(String),
    Conflict(String),
    Unavailable(String),
}

pub(super) fn dispatch_remote_command(
    control_state: &RemoteControlState,
    app_handle: &tauri::AppHandle,
    request: ProductCommand,
) -> Result<CommandReceipt, RemoteCommandDispatchError> {
    let event = match normalize_command(request) {
        Ok(event) => event,
        Err(error) => return Err(RemoteCommandDispatchError::InvalidRequest(error)),
    };

    let outcome = match control_state.record_command(&event) {
        Ok(outcome) => outcome,
        Err(RecordCommandError::CommandIdConflict) => {
            return Err(RemoteCommandDispatchError::Conflict(
                "The command id was already used for a different command.".to_string(),
            ));
        }
        Err(RecordCommandError::Unavailable(error)) => {
            return Err(RemoteCommandDispatchError::Unavailable(error));
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

    let _ = app_handle.emit(REMOTE_CONTROL_COMMAND_EVENT, event.clone());

    Ok(CommandReceipt {
        command_id: event.command_id,
        duplicate: false,
    })
}

pub(super) fn dispatch_error_response(error: RemoteCommandDispatchError) -> (StatusCode, Value) {
    let (status, message) = match error {
        RemoteCommandDispatchError::InvalidRequest(message) => (StatusCode::BAD_REQUEST, message),
        RemoteCommandDispatchError::Conflict(message) => (StatusCode::CONFLICT, message),
        RemoteCommandDispatchError::Unavailable(message) => {
            (StatusCode::SERVICE_UNAVAILABLE, message)
        }
    };

    (status, json!({ "error": message }))
}

pub(super) fn dispatch_error_code(error: &RemoteCommandDispatchError) -> HostErrorCode {
    match error {
        RemoteCommandDispatchError::InvalidRequest(_) => HostErrorCode::InvalidRequest,
        RemoteCommandDispatchError::Conflict(_) => HostErrorCode::Conflict,
        RemoteCommandDispatchError::Unavailable(_) => HostErrorCode::Unavailable,
    }
}

pub(super) fn dispatch_error_message(error: RemoteCommandDispatchError) -> String {
    match error {
        RemoteCommandDispatchError::InvalidRequest(message)
        | RemoteCommandDispatchError::Conflict(message)
        | RemoteCommandDispatchError::Unavailable(message) => message,
    }
}
