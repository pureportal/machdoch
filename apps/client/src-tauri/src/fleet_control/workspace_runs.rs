use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tauri::Manager;

use crate::workspace_run;

pub(super) async fn invoke(
    app: &tauri::AppHandle,
    command: &str,
    args: &Value,
) -> Result<Value, Value> {
    let mut request = args.get("request").unwrap_or(args).clone();
    if let Some(encoded) = request.as_object_mut().unwrap().remove("documentBase64") {
        let text = String::from_utf8(
            STANDARD
                .decode(encoded.as_str().unwrap())
                .map_err(|error| json!(error.to_string()))?,
        )
        .map_err(|error| json!(error.to_string()))?;
        if command == "save_workspace_run_configuration_document" {
            request["document"] =
                serde_json::from_str::<Value>(&text).map_err(|error| json!(error.to_string()))?;
        } else {
            request["documentJson"] = json!(text);
        }
    }
    let workspace = request["workspaceRoot"].as_str().unwrap().to_owned();
    let result = match command {
        "get_workspace_run_configuration_document" => serde_json::to_value(
            workspace_run::get_workspace_run_configuration_document(app.state(), workspace)
                .await
                .map_err(|error| json!(error))?,
        ),
        "get_workspace_run_snapshot" => serde_json::to_value(
            workspace_run::get_workspace_run_snapshot(app.state(), workspace)
                .await
                .map_err(|error| json!(error))?,
        ),
        "save_workspace_run_configuration_document" => serde_json::to_value(
            workspace_run::save_workspace_run_configuration_document(
                app.state(),
                serde_json::from_value(request).map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "precheck_workspace_run_configuration_json" => serde_json::to_value(
            workspace_run::precheck_workspace_run_configuration_json(
                serde_json::from_value(request).map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "start_workspace_run_configuration" => serde_json::to_value(
            workspace_run::start_workspace_run_configuration(
                app.state(),
                serde_json::from_value(request).map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "stop_workspace_run_configuration" => serde_json::to_value(
            workspace_run::stop_workspace_run_configuration(
                app.state(),
                serde_json::from_value(request).map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "restart_workspace_run_configuration" => serde_json::to_value(
            workspace_run::restart_workspace_run_configuration(
                app.state(),
                serde_json::from_value(request).map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        _ => return Err(json!("Unknown workspace run operation.")),
    };
    result.map_err(|error| json!(error.to_string()))
}
