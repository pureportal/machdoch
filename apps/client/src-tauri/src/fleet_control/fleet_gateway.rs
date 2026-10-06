use machdoch_fleet_protocol::{HostErrorCode, HostRequest, HostResponse};
use tauri::Manager;

use super::{
    dispatch::{dispatch_error_code, dispatch_error_message, dispatch_fleet_command},
    snapshot::create_snapshot_locked,
    FleetControlState,
};

pub(crate) fn handle_fleet_request(
    app_handle: &tauri::AppHandle,
    request: HostRequest,
) -> HostResponse {
    match request {
        HostRequest::DeviceSettings { request } => HostResponse::DeviceSettings {
            response: crate::fleet_operations::handle(
                app_handle,
                request,
                crate::fleet_operations::OperationDomain::DeviceSettings,
            ),
        },
        HostRequest::Workspace { request } => HostResponse::Workspace {
            response: crate::fleet_operations::handle(
                app_handle,
                request,
                crate::fleet_operations::OperationDomain::Workspace,
            ),
        },
        HostRequest::Instructions { request } => HostResponse::Instructions {
            response: crate::fleet_operations::handle(
                app_handle,
                request,
                crate::fleet_operations::OperationDomain::Instructions,
            ),
        },
        HostRequest::Ralph { request } => HostResponse::Ralph {
            response: crate::fleet_operations::handle(
                app_handle,
                request,
                crate::fleet_operations::OperationDomain::Ralph,
            ),
        },
        HostRequest::Scheduler { request } => HostResponse::Scheduler {
            response: crate::fleet_operations::handle(
                app_handle,
                request,
                crate::fleet_operations::OperationDomain::Scheduler,
            ),
        },
        HostRequest::Media { request } => HostResponse::Media {
            response: crate::fleet_operations::handle(
                app_handle,
                request,
                crate::fleet_operations::OperationDomain::Media,
            ),
        },
        HostRequest::GetProductSnapshot => product_snapshot(app_handle),
        HostRequest::ExecuteProductCommand { command } => {
            execute_product_command(app_handle, command)
        }
        HostRequest::ValidatePreviewTarget { target } => preview_request(app_handle, target, None),
        HostRequest::OpenPreviewTunnel {
            target,
            tunnel_id,
            token,
        } => preview_request(app_handle, target, Some((tunnel_id, token))),
        HostRequest::GetWorkspaceRuns { .. } | HostRequest::ExecuteWorkspaceRun { .. } => {
            HostResponse::Error {
                code: HostErrorCode::Unavailable,
                message: "Remote services and previews require the headless Fleet service."
                    .to_string(),
            }
        }
    }
}

fn preview_request(
    app: &tauri::AppHandle,
    target: serde_json::Value,
    tunnel: Option<(String, String)>,
) -> HostResponse {
    let result = (|| {
        let workspace = target["workspace"]
            .as_str()
            .ok_or("Choose a workspace listed on this device.")?;
        super::workspace::require_known_workspace(app, workspace).map_err(|error| {
            error
                .as_str()
                .unwrap_or("Invalid preview workspace.")
                .to_owned()
        })?;
        let target = crate::fleet::preview::validate(app, target)?;
        if let Some((id, token)) = tunnel {
            tauri::async_runtime::block_on(crate::fleet::preview::open(
                app.clone(),
                target,
                id,
                token,
            ))?;
            Ok(HostResponse::PreviewTunnelReady)
        } else {
            Ok(HostResponse::PreviewTargetReady)
        }
    })();
    result.unwrap_or_else(|message: String| HostResponse::Error {
        code: HostErrorCode::Unavailable,
        message,
    })
}

pub(super) fn product_snapshot(app_handle: &tauri::AppHandle) -> HostResponse {
    let state = app_handle.state::<FleetControlState>();
    if state.ensure_state_loaded().is_err() {
        return HostResponse::Error {
            code: HostErrorCode::Internal,
            message: "Product state is unavailable.".to_string(),
        };
    }
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
        Ok(mut snapshot) => {
            if snapshot["shell"]["ralph"].is_object() {
                snapshot["shell"]["ralph"]["editorAvailable"] = serde_json::json!(true);
            }
            HostResponse::ProductSnapshot { snapshot }
        }
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
    let state = app_handle.state::<FleetControlState>();
    match dispatch_fleet_command(&state, app_handle, command) {
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
                history: None,
                special_kind: None,
                pose_scene: None,
                name: None,
                repository: None,
                branch: None,
                shallow: None,
                initialize_git: None,
                project_id: None,
                kind: ProductCommandKind::CreateSession,
                command_id: Some("command-1".to_string()),
                task_id: None,
                session_id: None,
                prompt: None,
                goal_objective: None,
                iteration_count: None,
                iteration_mode: None,
                running_action: None,
                direction: None,
                target_index: None,
                variable_values: None,
                paths: None,
                context_pack: None,
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
                destination_workspace: None,
                enabled: None,
                memory_id: None,
                attachment_id: None,
                context_pack_id: None,
                message_id: None,
                run_id: None,
                flow_id: None,
                scope: None,
                parameters: None,
                max_transitions: None,
                isolated: None,
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
