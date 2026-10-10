use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tauri::Manager;

pub(crate) async fn invoke(
    app: tauri::AppHandle,
    command: String,
    mut args: Value,
) -> Result<Value, Value> {
    if !machdoch_fleet_protocol::workspace::valid_workspace_invocation(&command, &args) {
        return Err(json!("Invalid workspace operation."));
    }
    if command == "get_context_pack_documents" {
        return super::context_packs::documents(app, &args).await;
    }
    if command == "reset_desktop_task_timeout" {
        return crate::desktop_task::reset_desktop_task_timeout(
            app.clone(),
            app.state(),
            args["taskId"].as_str().unwrap().to_owned(),
            args["idleTimeoutMinutes"]
                .as_f64()
                .map(|value| value as u32),
        )
        .await
        .map_err(|error| json!(error));
    }
    if matches!(
        command.as_str(),
        "get_session_export"
            | "import_session_export"
            | "get_session_index"
            | "get_session_message_page"
            | "get_session_composer_text"
            | "get_session_file_change_files"
            | "get_session_file_change_hunks"
    ) {
        return super::session_data::invoke(&app, &command, &args).await;
    }
    if matches!(
        command.as_str(),
        "import_context_attachment" | "read_context_attachment_preview"
    ) {
        return super::context_attachments::invoke(app, &command, &args).await;
    }
    if command == "get_user_memory_settings" {
        return serde_json::to_value(
            crate::runtime_snapshot::get_user_memory_settings()
                .await
                .map_err(|error| json!(error))?,
        )
        .map_err(|error| json!(error.to_string()));
    }
    let request = args.get("request").unwrap_or(&args);
    let workspace = request["workspaceRoot"]
        .as_str()
        .ok_or_else(|| json!("Select a workspace."))?;
    if command == "stop_all_workspace_terminals" {
        super::workspace::require_registered_workspace(&app, workspace)?;
        return super::workspace_terminal::invoke(&app, &command, &args).await;
    }
    super::workspace::require_known_workspace(&app, workspace)?;
    if command.contains("workspace_terminal") || command == "discover_workspace_shells" {
        return super::workspace_terminal::invoke(&app, &command, &args).await;
    }
    let result = match command.as_str() {
        "get_workspace_run_configuration_document"
        | "get_workspace_run_snapshot"
        | "save_workspace_run_configuration_document"
        | "precheck_workspace_run_configuration_json"
        | "start_workspace_run_configuration"
        | "stop_workspace_run_configuration"
        | "restart_workspace_run_configuration" => {
            return super::workspace_runs::invoke(&app, &command, &args).await
        }
        "get_runtime_snapshot"
        | "run_mcp_command"
        | "run_provider_sync_command"
        | "get_workspace_memory_entries"
        | "get_workspace_reasoning_bank_lessons"
        | "get_workspace_mcp_config_document"
        | "forget_workspace_memory"
        | "save_workspace_default_mode"
        | "save_workspace_memory_override"
        | "save_workspace_adaptive_controller_override"
        | "save_workspace_reasoning_bank_enabled"
        | "save_workspace_auto_gitignore"
        | "save_workspace_reasoning_mode"
        | "save_workspace_reasoning_execution_mode"
        | "save_workspace_context_window"
        | "save_workspace_mcp_config_document" => {
            return super::workspace_configuration::invoke(&app, &command, &args).await;
        }
        "read_workspace_file_preview" => {
            let path = crate::desktop_task::resolve_workspace_file_preview_path(
                app.clone(),
                workspace.to_owned(),
                args["relativePath"].as_str().unwrap().to_owned(),
            )
            .await
            .map_err(|error| json!(error))?;
            let preview = tauri::async_runtime::spawn_blocking(move || {
                use std::io::Read;
                let file = std::fs::File::open(&path).map_err(|error| error.to_string())?;
                let mut bytes = Vec::new();
                file.take(32 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
                if bytes.len() > 32 * 1024 * 1024 { return Err("The file exceeds the 32 MiB remote preview limit. Open it on the device.".to_string()); }
                Ok(json!({ "dataBase64": STANDARD.encode(bytes), "mediaType": mime_guess::from_path(path).first_or_octet_stream().as_ref() }))
            }).await.map_err(|error| json!(error.to_string()))?.map_err(|error| json!(error))?;
            Ok(preview)
        }
        "open_workspace_path" => serde_json::to_value(
            crate::desktop_task::open_workspace_path(
                workspace.to_owned(),
                args["relativePath"].as_str().unwrap().to_owned(),
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "list_workspace_directory" => serde_json::to_value(
            crate::workspace_tools::files::list_workspace_directory(
                workspace.to_owned(),
                args["relativePath"].as_str().unwrap().to_owned(),
                Some(args["offset"].as_f64().unwrap() as usize),
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "read_workspace_file" => serde_json::to_value(
            crate::workspace_tools::files::read_workspace_file(
                workspace.to_owned(),
                args["relativePath"].as_str().unwrap().to_owned(),
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "save_workspace_file" => {
            let request = args["request"].as_object_mut().unwrap();
            let bytes = STANDARD
                .decode(request.remove("contentBase64").unwrap().as_str().unwrap())
                .map_err(|error| json!(error.to_string()))?;
            let content = String::from_utf8(bytes).map_err(|error| json!(error.to_string()))?;
            request.insert("content".to_string(), json!(content));
            serde_json::to_value(
                crate::workspace_tools::files::save_workspace_file(
                    serde_json::from_value(args["request"].clone())
                        .map_err(|error| json!(error.to_string()))?,
                )
                .await
                .map_err(|error| json!(error))?,
            )
        }
        "create_workspace_entry" => serde_json::to_value(
            crate::workspace_tools::files::create_workspace_entry(
                serde_json::from_value(args["request"].clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "rename_workspace_entry" => serde_json::to_value(
            crate::workspace_tools::files::rename_workspace_entry(
                serde_json::from_value(args["request"].clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "delete_workspace_entry" => serde_json::to_value(
            crate::workspace_tools::files::delete_workspace_entry(
                serde_json::from_value(args["request"].clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "discover_workspace_git_repositories" => serde_json::to_value(
            crate::workspace_git::discover_workspace_git_repositories(workspace.to_owned())
                .await
                .map_err(|error| json!(error))?,
        ),
        "get_workspace_git_overview" => serde_json::to_value(
            crate::workspace_git::get_workspace_git_overview(
                serde_json::from_value(args["request"].clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "get_workspace_git_diff" => serde_json::to_value(
            crate::workspace_git::get_workspace_git_diff(
                serde_json::from_value(args["request"].clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "get_workspace_pull_requests" => serde_json::to_value(
            crate::workspace_git::get_workspace_pull_requests(
                serde_json::from_value(args["request"].clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        "run_workspace_git_action" => serde_json::to_value(
            crate::workspace_git::run_workspace_git_action(
                serde_json::from_value(args["request"].clone())
                    .map_err(|error| json!(error.to_string()))?,
            )
            .await
            .map_err(|error| json!(error))?,
        ),
        _ => return Err(json!("Unknown workspace operation.")),
    };
    result.map_err(|error| json!(error.to_string()))
}
