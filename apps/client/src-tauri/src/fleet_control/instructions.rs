use serde_json::{json, Value};
use tauri::Emitter;

pub(crate) async fn invoke(
    app: tauri::AppHandle,
    command: String,
    args: Value,
) -> Result<Value, Value> {
    if !machdoch_fleet_protocol::instructions::valid_instruction_invocation(&command, &args) {
        return Err(json!("Invalid instruction operation."));
    }
    let workspace = args["request"]["workspaceRoot"]
        .as_str()
        .ok_or_else(|| json!("Select a workspace."))?;
    if !workspace.is_empty() {
        super::workspace::require_known_workspace(&app, workspace)?;
    }
    let arguments: Vec<String> = serde_json::from_value(args["request"]["arguments"].clone())
        .map_err(|error| json!(error.to_string()))?;
    for workspace in machdoch_fleet_protocol::instructions::referenced_workspaces(&arguments) {
        if arguments.first().map(String::as_str) == Some("workspaces")
            && arguments.get(1).map(String::as_str) == Some("relink")
        {
            crate::runtime_snapshot::resolve_workspace_root_path(workspace)
                .map_err(|error| json!(error))?;
        } else {
            super::workspace::require_known_workspace(&app, workspace)?;
        }
    }
    let mutated = !matches!(
        arguments.get(1).map(String::as_str),
        Some("list" | "status")
    );
    let request: crate::desktop_task::InstructionCommandRequest =
        serde_json::from_value(args["request"].clone())
            .map_err(|error| json!(error.to_string()))?;
    let result = crate::desktop_task::run_instruction_command(request)
        .await
        .map_err(|error| json!(error))?;
    if mutated {
        app.emit(
            "machdoch://user-settings-changed",
            json!({ "kind": "instructions", "updatedAt": super::now_millis() }),
        )
        .map_err(|error| {
            json!(format!(
                "Instructions were saved but the client could not refresh: {error}"
            ))
        })?;
    }
    Ok(result)
}
