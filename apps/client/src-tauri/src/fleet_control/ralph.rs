use serde_json::{json, Value};
use tauri::Manager;

pub(crate) async fn invoke(
    app: tauri::AppHandle,
    command: String,
    args: Value,
) -> Result<Value, Value> {
    if !machdoch_fleet_protocol::ralph::valid_ralph_invocation(&command, &args) {
        return Err(json!("Invalid RALPH operation."));
    }
    match command.as_str() {
        "run_ralph_command" => {
            let request: crate::desktop_task::RalphCommandRequest =
                serde_json::from_value(args["request"].clone())
                    .map_err(|error| json!(error.to_string()))?;
            let workspace = args["request"]["workspaceRoot"]
                .as_str()
                .ok_or_else(|| json!("Select a workspace."))?;
            let response = super::fleet_gateway::product_snapshot(&app);
            let machdoch_fleet_protocol::HostResponse::ProductSnapshot { snapshot } = response
            else {
                return Err(json!("Device state is unavailable."));
            };
            let shell = &snapshot["shell"];
            let known = shell["sessions"].as_array().is_some_and(|sessions| {
                sessions
                    .iter()
                    .any(|session| session["workspace"].as_str() == Some(workspace))
            }) || shell["ralph"]["workspaceRoot"].as_str() == Some(workspace)
                || shell["workspaces"].as_array().is_some_and(|entries| {
                    entries
                        .iter()
                        .any(|entry| entry["root"].as_str() == Some(workspace))
                })
                || shell["projectLibrary"]["projects"]
                    .as_array()
                    .is_some_and(|projects| {
                        projects.iter().any(|project| {
                            project["status"].as_str() == Some("ready")
                                && project["workspace"].as_str() == Some(workspace)
                        })
                    });
            if !known {
                return Err(json!("Choose a workspace listed on this device."));
            }
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| json!("Open the desktop client before editing RALPH flows."))?;
            crate::desktop_task::run_ralph_command(
                app.clone(),
                app.state::<crate::desktop_task::DesktopTaskCancelMap>(),
                window,
                request,
            )
            .await
            .map_err(|error| json!(error))
        }
        "get_active_desktop_tasks" => {
            let result = crate::desktop_task::get_active_desktop_tasks(app.state())
                .await
                .map_err(|error| json!(error))?;
            serde_json::to_value(result).map_err(|error| json!(error.to_string()))
        }
        "get_user_internal_task_model_settings" => {
            let result = crate::runtime_snapshot::get_user_internal_task_model_settings()
                .await
                .map_err(|error| json!(error))?;
            serde_json::to_value(result).map_err(|error| json!(error.to_string()))
        }
        "get_recent_desktop_task_results" => {
            let task_ids: Vec<String> = serde_json::from_value(args["taskIds"].clone())
                .map_err(|error| json!(error.to_string()))?;
            let result =
                crate::desktop_task::get_recent_desktop_task_results(app.state(), task_ids)
                    .await
                    .map_err(|error| json!(error))?;
            serde_json::to_value(result).map_err(|error| json!(error.to_string()))
        }
        "cancel_desktop_task" => {
            let task_id = args["taskId"]
                .as_str()
                .ok_or_else(|| json!("Select a task."))?
                .to_owned();
            crate::desktop_task::cancel_desktop_task(app.state(), task_id)
                .await
                .map_err(|error| json!(error))?;
            Ok(Value::Null)
        }
        _ => Err(json!("Unknown RALPH operation.")),
    }
}
