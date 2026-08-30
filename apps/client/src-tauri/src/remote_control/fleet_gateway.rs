use machdoch_fleet_protocol::{HostErrorCode, HostRequest, HostResponse};
use tauri::Manager;

use super::{
    dispatch::{dispatch_error_code, dispatch_error_message, dispatch_remote_command},
    status::create_snapshot_locked,
    RemoteControlState,
};

pub(crate) fn handle_fleet_request(
    app_handle: &tauri::AppHandle,
    request: HostRequest,
) -> HostResponse {
    match request {
        HostRequest::GetProductSnapshot => product_snapshot(app_handle),
        HostRequest::ExecuteProductCommand { command } => {
            execute_product_command(app_handle, command)
        }
    }
}

fn product_snapshot(app_handle: &tauri::AppHandle) -> HostResponse {
    let state = app_handle.state::<RemoteControlState>();
    let snapshot = {
        let Ok(inner) = state.shared.inner.lock() else {
            return HostResponse::Error {
                code: HostErrorCode::Internal,
                message: "Product state is unavailable.".to_string(),
            };
        };
        create_snapshot_locked(&inner)
    };

    match serde_json::to_value(snapshot) {
        Ok(snapshot) => HostResponse::ProductSnapshot { snapshot },
        Err(_) => HostResponse::Error {
            code: HostErrorCode::Internal,
            message: "Product state is unavailable.".to_string(),
        },
    }
}

fn execute_product_command(
    app_handle: &tauri::AppHandle,
    command: machdoch_fleet_protocol::ProductCommand,
) -> HostResponse {
    let state = app_handle.state::<RemoteControlState>();
    match dispatch_remote_command(&state, app_handle, command) {
        Ok(receipt) => HostResponse::CommandAccepted { receipt },
        Err(error) => {
            let code = dispatch_error_code(&error);
            HostResponse::Error {
                code,
                message: dispatch_error_message(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use machdoch_fleet_protocol::{HostRequest, ProductCommand, ProductCommandKind};

    #[test]
    fn gateway_requests_have_no_document_operation() {
        let snapshot = serde_json::to_value(HostRequest::GetProductSnapshot)
            .expect("snapshot request should serialize");
        let command = serde_json::to_value(HostRequest::ExecuteProductCommand {
            command: ProductCommand {
                kind: ProductCommandKind::CreateSession,
                command_id: Some("command-1".to_string()),
                task_id: None,
                session_id: None,
                prompt: None,
                title: None,
                tags: None,
                provider: None,
                model: None,
                model_id: None,
                mode: None,
                reasoning: None,
                prompt_enhancement_mode: None,
                interview_enabled: None,
                workspace: None,
                enabled: None,
                attachment_id: None,
                context_pack_id: None,
                message_id: None,
                job_id: None,
                run_id: None,
                target: None,
                aspect_ratio: None,
                output_count: None,
                output_format: None,
                transparent_background: None,
            },
        })
        .expect("command request should serialize");

        assert_eq!(snapshot["type"], "getProductSnapshot");
        assert_eq!(command["type"], "executeProductCommand");
        assert!(!snapshot.to_string().contains("document"));
        assert!(!command.to_string().contains("document"));
    }
}
