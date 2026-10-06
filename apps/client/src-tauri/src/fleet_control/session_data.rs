use serde_json::{json, Value};
use std::io::Read;

pub(super) async fn invoke(
    app: &tauri::AppHandle,
    command: &str,
    args: &Value,
) -> Result<Value, Value> {
    let prepared = if command == "import_session_export" {
        let path = args["path"]
            .as_str()
            .ok_or_else(|| json!("Select a session export."))?;
        crate::media::fleet_transfer::require_transfer_path(app, path, false)
            .map_err(|error| json!(error))?;
        let file = std::fs::File::open(path).map_err(|error| json!(error.to_string()))?;
        let mut bytes = Vec::new();
        file.take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| json!(error.to_string()))?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err(json!("The session export exceeds the 64 MiB import limit."));
        }
        let payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
            json!("The session file is not valid JSON. Choose a Machdoch session export.")
        })?;
        if payload["kind"] != "machdoch.sessions"
            || payload["version"] != 1
            || !payload["sessions"]
                .as_array()
                .is_some_and(|sessions| !sessions.is_empty() && sessions.len() <= 5_000)
        {
            return Err(json!(
                "The session file is invalid. Choose a Machdoch session export."
            ));
        }
        for session in payload["sessions"].as_array().unwrap() {
            if let Some(workspace) = session["workspace"].as_str() {
                super::workspace::require_known_workspace(app, workspace)?;
            }
            if let Some(messages) = session["messages"].as_array() {
                for message in messages {
                    if let Some(workspace) = message["settings"]["workspace"].as_str() {
                        super::workspace::require_known_workspace(app, workspace)?;
                    }
                }
            }
        }
        json!({ "payload": payload })
    } else {
        args.clone()
    };
    super::client_requests::invoke(app, command, &prepared).await
}
