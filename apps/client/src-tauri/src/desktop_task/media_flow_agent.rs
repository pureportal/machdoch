use serde_json::Value;

#[tauri::command]
pub async fn run_media_flow_agent(
    workspace_root: Option<String>,
    request: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = match workspace_root.filter(|root| !root.trim().is_empty()) {
            Some(root) => root,
            None => crate::runtime_snapshot::get_user_config_directory()?
                .display()
                .to_string(),
        };
        super::cli_commands::execute_media_flow_agent(&root, &request)
    })
    .await
    .map_err(|error| format!("The Media Studio assistant stopped unexpectedly. {error}"))?
}
