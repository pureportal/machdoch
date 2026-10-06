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

pub(super) fn validate(
    app: &tauri::AppHandle,
    event: &super::commands::FleetControlCommandEvent,
) -> Result<(), String> {
    let workspace =
        session_workspace(app, event.session_id.as_deref().ok_or("Select a session.")?)?;
    for path in event.paths.as_ref().ok_or("Select an attachment.")? {
        if let Ok(url) = url::Url::parse(path) {
            if matches!(url.scheme(), "http" | "https" | "mailto" | "ftp") {
                continue;
            }
        }
        crate::desktop_task::resolve_context_attachment_path(workspace.as_deref(), path)?;
    }
    Ok(())
}

fn message_workspace<'a>(session: &'a Value, message_id: &str) -> Result<Option<&'a str>, String> {
    let messages = session["messages"]
        .as_array()
        .ok_or("Session messages are unavailable. Refresh the device.")?;
    let message = messages
        .iter()
        .find(|message| message["id"].as_str() == Some(message_id))
        .ok_or("This message is no longer available. Refresh the device.")?;
    let settings = message
        .get("settings")
        .filter(|settings| settings.is_object())
        .or_else(|| {
            message["taskId"].as_str().and_then(|task_id| {
                messages
                    .iter()
                    .find(|request| {
                        request["role"].as_str() == Some("user")
                            && request["taskId"].as_str() == Some(task_id)
                            && request["settings"].is_object()
                    })
                    .and_then(|request| request.get("settings"))
            })
        });
    Ok(match settings {
        Some(settings) => settings["workspace"].as_str(),
        None => session["workspace"].as_str(),
    })
}

fn preview_workspace(
    app: &tauri::AppHandle,
    session_id: &str,
    message_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(message_id) = message_id else {
        return session_workspace(app, session_id);
    };
    let state = crate::shell_state::load_authoritative_shell_state(app)?;
    let session = state["sessions"]
        .as_array()
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|session| session["id"].as_str() == Some(session_id))
        })
        .ok_or("This session is no longer available. Refresh the device.")?;
    message_workspace(session, message_id).map(|workspace| workspace.map(str::to_owned))
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
    let session_id = args["sessionId"]
        .as_str()
        .ok_or_else(|| json!("Select a session."))?;
    let workspace = preview_workspace(&app, session_id, args["messageId"].as_str())
        .map_err(|error| json!(error))?;
    let resolved =
        crate::desktop_task::resolve_context_attachment_path(workspace.as_deref(), &path)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn historical_previews_use_the_request_workspace_for_both_sides_of_a_task() {
        let session = json!({
            "workspace": "C:/current",
            "messages": [
                { "id": "request", "role": "user", "taskId": "task", "settings": { "workspace": "C:/historical" } },
                { "id": "reply", "role": "agent", "taskId": "task" }
            ]
        });
        assert_eq!(
            message_workspace(&session, "request").unwrap(),
            Some("C:/historical")
        );
        assert_eq!(
            message_workspace(&session, "reply").unwrap(),
            Some("C:/historical")
        );
        assert!(message_workspace(&session, "unknown").is_err());
    }

    #[test]
    fn an_unassigned_request_does_not_gain_the_current_workspace() {
        let session = json!({
            "workspace": "C:/current",
            "messages": [
                { "id": "unassigned", "role": "user", "settings": { "workspace": null } },
                { "id": "without-settings", "role": "user" }
            ]
        });
        assert_eq!(message_workspace(&session, "unassigned").unwrap(), None);
        assert_eq!(
            message_workspace(&session, "without-settings").unwrap(),
            Some("C:/current")
        );
    }
}
