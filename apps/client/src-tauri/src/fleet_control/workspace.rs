use serde_json::{json, Value};

fn registered_workspace_roots(app: &tauri::AppHandle) -> Result<Vec<String>, Value> {
    let machdoch_fleet_protocol::HostResponse::ProductSnapshot { snapshot } =
        super::fleet_gateway::product_snapshot(app)
    else {
        return Err(json!("Device state is unavailable."));
    };
    let shell = &snapshot["shell"];
    let mut roots = Vec::new();
    for (collection, field) in [
        ("sessions", "workspace"),
        ("workspaces", "root"),
        ("visibleMessages", "workspace"),
    ] {
        if let Some(entries) = shell[collection].as_array() {
            roots.extend(
                entries
                    .iter()
                    .filter_map(|entry| entry[field].as_str().map(str::to_owned)),
            );
        }
    }
    for section in ["ralph", "scheduler"] {
        if let Some(root) = shell[section]["workspaceRoot"].as_str() {
            roots.push(root.to_owned());
        }
    }
    if let Some(projects) = shell["projectLibrary"]["projects"].as_array() {
        roots.extend(
            projects
                .iter()
                .filter(|project| project["status"].as_str() == Some("ready"))
                .filter_map(|project| project["workspace"].as_str().map(str::to_owned)),
        );
    }
    Ok(roots)
}

pub(super) fn require_registered_workspace(
    app: &tauri::AppHandle,
    workspace: &str,
) -> Result<(), Value> {
    if registered_workspace_roots(app)?
        .iter()
        .any(|root| root == workspace)
    {
        return Ok(());
    }
    Err(json!("Choose a workspace listed on this device."))
}

pub(super) fn require_known_workspace(
    app: &tauri::AppHandle,
    workspace: &str,
) -> Result<(), Value> {
    let selected_root = crate::runtime_snapshot::resolve_workspace_root_path(workspace)
        .map_err(|error| json!(error))?;
    if registered_workspace_roots(app)?.iter().any(|known| {
        crate::runtime_snapshot::resolve_workspace_root_path(known)
            .is_ok_and(|root| root == selected_root)
    }) {
        return Ok(());
    }
    Err(json!("Choose a workspace listed on this device."))
}
