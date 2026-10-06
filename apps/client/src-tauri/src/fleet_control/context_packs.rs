use serde_json::{json, Value};
use std::io::Read;

fn same_workspace(left: &str, right: &str) -> bool {
    let left = left.trim().replace('\\', "/");
    let right = right.trim().replace('\\', "/");
    let left = left.trim_end_matches('/');
    let right = right.trim_end_matches('/');
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

fn visible(pack: &Value, workspace: Option<&str>) -> bool {
    pack["workspace"].is_null()
        || pack["workspace"]
            .as_str()
            .is_some_and(|root| workspace.is_some_and(|workspace| same_workspace(root, workspace)))
}

pub(super) async fn documents(app: tauri::AppHandle, args: &Value) -> Result<Value, Value> {
    let session_id = args["sessionId"]
        .as_str()
        .ok_or_else(|| json!("Select a session."))?;
    let workspace = super::context_attachments::session_workspace(&app, session_id)
        .map_err(|error| json!(error))?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = crate::shell_state::load_authoritative_shell_state(&app)?;
        let packs = state["contextPacks"]
            .as_array()
            .ok_or("Context packs are unavailable. Refresh the device.")?;
        let packs = packs
            .iter()
            .filter(|pack| visible(pack, workspace.as_deref()))
            .cloned()
            .collect::<Vec<_>>();
        if packs.len() > 160
            || !packs
                .iter()
                .all(machdoch_fleet_protocol::context_packs::valid_document)
        {
            return Err(
                "Context pack documents are invalid. Review them on the device.".to_owned(),
            );
        }
        Ok(json!(packs))
    })
    .await
    .map_err(|error| json!(error.to_string()))?
    .map_err(|error| json!(error))
}

pub(super) fn prepare(
    app: &tauri::AppHandle,
    event: &mut super::commands::FleetControlCommandEvent,
) -> Result<(), String> {
    let workspace = super::context_attachments::session_workspace(
        app,
        event.session_id.as_deref().ok_or("Select a session.")?,
    )?;
    if event.kind == "save-context-pack" {
        let definition = event.context_pack.as_ref().ok_or("Enter a context pack.")?;
        if !machdoch_fleet_protocol::context_packs::valid_definition(definition) {
            return Err("The context pack is invalid. Review its fields.".to_owned());
        }
        if definition["scope"].as_str() == Some("workspace") && workspace.is_none() {
            return Err("Select a workspace for this context pack.".to_owned());
        }
        if let Some(id) = definition["id"].as_str() {
            let state = crate::shell_state::load_authoritative_shell_state(app)?;
            if !state["contextPacks"].as_array().is_some_and(|packs| {
                packs.iter().any(|pack| {
                    pack["id"].as_str() == Some(id) && visible(pack, workspace.as_deref())
                })
            }) {
                return Err(
                    "This context pack is no longer available. Refresh the device.".to_owned(),
                );
            }
        }
        for attachment in definition["contextAttachments"].as_array().unwrap() {
            if attachment["source"].as_str() != Some("path") {
                continue;
            }
            let path = attachment["path"].as_str().unwrap();
            if url::Url::parse(path)
                .is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "mailto" | "ftp"))
            {
                continue;
            }
            crate::desktop_task::resolve_context_attachment_path(workspace.as_deref(), path)?;
        }
        return Ok(());
    }
    if event.scope.as_deref() == Some("workspace") && workspace.is_none() {
        return Err("Select a workspace before importing context packs.".to_owned());
    }
    let path = event
        .paths
        .as_ref()
        .and_then(|paths| paths.first())
        .ok_or("Select a context pack file.")?;
    crate::media::fleet_transfer::require_transfer_path(app, path, false)?;
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("The context pack file exceeds the 64 MiB import limit.".to_owned());
    }
    let document: Value = serde_json::from_slice(&bytes).map_err(|_| {
        "The context pack file is not valid JSON. Choose a Machdoch export.".to_owned()
    })?;
    if !machdoch_fleet_protocol::context_packs::valid_export(&document) {
        return Err("The context pack file is invalid. Choose a Machdoch export.".to_owned());
    }
    event.imported_context_packs = Some(document);
    Ok(())
}
