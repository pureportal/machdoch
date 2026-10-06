use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::runtime_snapshot;

pub(super) async fn invoke(
    app: &tauri::AppHandle,
    command: &str,
    args: &Value,
) -> Result<Value, Value> {
    let request = args.get("request").unwrap_or(args);
    let workspace = request["workspaceRoot"].as_str().unwrap().to_owned();
    let result = match command {
        "run_mcp_command" => {
            return crate::desktop_task::run_mcp_command(
                serde_json::from_value(request.clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))
        }
        "run_provider_sync_command" => {
            return crate::desktop_task::run_provider_sync_command(
                serde_json::from_value(request.clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))
        }
        "get_runtime_snapshot" => serde_json::to_value(
            runtime_snapshot::get_runtime_snapshot(workspace)
                .await
                .map_err(|error| json!(error))?,
        ),
        "get_workspace_memory_entries" => serde_json::to_value(
            runtime_snapshot::get_workspace_memory_entries(workspace)
                .await
                .map_err(|error| json!(error))?,
        ),
        "get_workspace_reasoning_bank_lessons" => serde_json::to_value(
            runtime_snapshot::get_workspace_reasoning_bank_lessons(workspace)
                .await
                .map_err(|error| json!(error))?,
        ),
        "get_workspace_mcp_config_document" => serde_json::to_value(
            runtime_snapshot::get_workspace_mcp_config_document(workspace)
                .await
                .map_err(|error| json!(error))?,
        ),
        "forget_workspace_memory" => serde_json::to_value(
            runtime_snapshot::forget_workspace_memory(
                workspace,
                args["id"].as_str().unwrap().to_owned(),
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "save_workspace_default_mode" => serde_json::to_value(
            runtime_snapshot::save_workspace_default_mode(
                workspace,
                args["mode"].as_str().unwrap().to_owned(),
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "save_workspace_memory_override" => serde_json::to_value(
            runtime_snapshot::save_workspace_memory_override(workspace, args["enabled"].as_bool())
                .await
                .map_err(|error| json!(error))?,
        ),
        "save_workspace_adaptive_controller_override" => serde_json::to_value(
            runtime_snapshot::save_workspace_adaptive_controller_override(
                workspace,
                args["enabled"].as_bool(),
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "save_workspace_reasoning_bank_enabled" => serde_json::to_value(
            runtime_snapshot::save_workspace_reasoning_bank_enabled(
                workspace,
                args["enabled"].as_bool().unwrap(),
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "save_workspace_reasoning_mode" => serde_json::to_value(
            runtime_snapshot::save_workspace_reasoning_mode(
                workspace,
                args["reasoning"].as_str().unwrap().to_owned(),
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "save_workspace_reasoning_execution_mode" => serde_json::to_value(
            runtime_snapshot::save_workspace_reasoning_execution_mode(
                workspace,
                serde_json::from_value(args["reasoningMode"].clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "save_workspace_context_window" => serde_json::to_value(
            runtime_snapshot::save_workspace_context_window(
                workspace,
                serde_json::from_value(args["contextWindow"].clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "save_workspace_mcp_config_document" => {
            let raw = String::from_utf8(
                STANDARD
                    .decode(args["rawBase64"].as_str().unwrap())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .map_err(|error| json!(error.to_string()))?;
            let expected_raw = String::from_utf8(
                STANDARD
                    .decode(args["expectedRawBase64"].as_str().unwrap())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .map_err(|error| json!(error.to_string()))?;
            serde_json::to_value(
                runtime_snapshot::save_workspace_mcp_config_document(
                    app.state(),
                    workspace,
                    raw,
                    Some(expected_raw),
                )
                .await
                .map_err(|error| json!(error))?,
            )
        }
        _ => return Err(json!("Unknown workspace configuration operation.")),
    };
    let result = result.map_err(|error| json!(error.to_string()))?;
    if command == "save_workspace_mcp_config_document" {
        app.emit("machdoch://user-settings-changed", json!({ "kind": "mcp", "updatedAt": super::now_millis() })).map_err(|error| json!(format!("The MCP configuration was saved, but the client could not refresh: {error}. Refresh the configuration.")))?;
    }
    Ok(result)
}
