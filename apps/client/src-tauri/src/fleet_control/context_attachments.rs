use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

pub(super) fn session_workspace(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Option<String>, String> {
    let machdoch_fleet_protocol::HostResponse::ProductSnapshot { snapshot } =
        super::fleet_gateway::product_snapshot(app)
    else {
        return Err("Device state is unavailable.".to_owned());
    };
    let session = snapshot["shell"]["sessions"]
        .as_array()
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|session| session["id"].as_str() == Some(session_id))
        })
        .ok_or("This session is no longer available. Refresh the device.")?;
    Ok(session["workspace"].as_str().map(str::to_owned))
}

pub(super) fn validate(event: &super::commands::FleetControlCommandEvent) -> Result<(), String> {
    for path in event.paths.as_ref().ok_or("Select an attachment.")? {
        if let Ok(url) = url::Url::parse(path) {
            if matches!(url.scheme(), "http" | "https" | "mailto" | "ftp") {
                continue;
            }
        }
        crate::desktop_task::local_file_links::resolve_local_path(path)?;
    }
    Ok(())
}

pub(super) async fn invoke(
    app: tauri::AppHandle,
    command: &str,
    args: &Value,
) -> Result<Value, Value> {
    let path = args["path"]
        .as_str()
        .ok_or_else(|| json!("Select an attachment."))?
        .to_owned();
    if command == "import_context_attachment" {
        crate::media::fleet_transfer::require_transfer_path(&app, &path, false)
            .map_err(|error| json!(error))?;
        let name = args["name"]
            .as_str()
            .ok_or_else(|| json!("Enter a filename."))?
            .to_owned();
        return tauri::async_runtime::spawn_blocking(move || {
            crate::desktop_task::persist_context_attachment(std::path::Path::new(&path), &name)
                .map(|path| json!({"path": path}))
        })
        .await
        .map_err(|error| json!(error.to_string()))?
        .map_err(|error| json!(error));
    }
    if command == "list_context_attachment_directory" {
        return serde_json::to_value(
            crate::workspace_tools::files::list_workspace_directory(
                path,
                ".".to_owned(),
                Some(args["offset"].as_f64().unwrap() as usize),
            )
            .await
            .map_err(|error| json!(error))?,
        )
        .map_err(|error| json!(error.to_string()));
    }
    let resolved = crate::desktop_task::local_file_links::resolve_local_path(&path)
        .map_err(|error| json!(error))?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let file = std::fs::File::open(&resolved).map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.take(32 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() > 32 * 1024 * 1024 { return Err("The attachment exceeds the 32 MiB preview limit.".to_owned()); }
        Ok(json!({"dataBase64": STANDARD.encode(bytes), "mediaType": mime_guess::from_path(resolved).first_or_octet_stream().as_ref()}))
    }).await.map_err(|error| json!(error.to_string()))?.map_err(|error| json!(error))
}
