use serde_json::{json, Value};

pub(crate) async fn invoke(
    app: tauri::AppHandle,
    command: String,
    mut args: Value,
    operation_id: String,
) -> Result<Value, Value> {
    if !machdoch_fleet_protocol::scheduler::valid_scheduler_invocation(&command, &args) {
        return Err(json!("Invalid Scheduler operation."));
    }
    let workspace = args["request"]["workspaceRoot"]
        .as_str()
        .ok_or_else(|| json!("Select a workspace."))?;
    super::workspace::require_known_workspace(&app, workspace)?;
    if command == "run_ralph_command" {
        return super::ralph::invoke(app, command, args).await;
    }
    let arguments = args["request"]["arguments"]
        .as_array_mut()
        .ok_or_else(|| json!("Invalid Scheduler arguments."))?;
    if arguments
        .first()
        .and_then(Value::as_str)
        .is_some_and(|action| {
            [
                "create", "pause", "resume", "delete", "trigger", "retry", "cancel",
            ]
            .contains(&action)
        })
        && !arguments
            .iter()
            .any(|value| value.as_str() == Some("--request-id"))
    {
        arguments.extend([json!("--request-id"), json!(operation_id)]);
    }
    let request: crate::desktop_task::SchedulerCommandRequest =
        serde_json::from_value(args["request"].clone())
            .map_err(|error| json!(error.to_string()))?;
    crate::desktop_task::run_scheduler_command(request)
        .await
        .map_err(|error| json!(error))
}
