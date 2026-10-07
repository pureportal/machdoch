use std::{fs, io::ErrorKind, path::Path, time::Duration};

use zeroize::Zeroizing;

pub(crate) fn ensure_workspace_storage(workspace_root: &Path) -> Result<(), String> {
    let directory = workspace_root.join(".machdoch");
    if !directory.exists() {
        return Ok(());
    }
    for path in [
        directory.clone(),
        directory.join("local"),
        directory.join("local/state"),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Workspace storage must be a regular directory: {}",
                    path.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to inspect workspace storage: {error}")),
        }
    }
    let marker = directory.join("local/state/storage-layout.json");
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err(format!(
                "Workspace storage must be a regular file: {}",
                marker.display()
            ));
        }
        Ok(_) => {
            let content = fs::read_to_string(&marker)
                .map_err(|error| format!("Failed to read workspace storage layout: {error}"))?;
            let value: serde_json::Value = serde_json::from_str(&content)
                .map_err(|error| format!("Invalid workspace storage layout: {error}"))?;
            if value.get("version").and_then(serde_json::Value::as_u64) == Some(1) {
                return Ok(());
            }
            return Err("Unsupported workspace storage layout.".to_string());
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to inspect workspace storage layout: {error}"
            ))
        }
    }
    crate::shared_cli::run_shared_cli_json_command(
        &[
            "workspace-storage-migrate".to_string(),
            workspace_root.to_string_lossy().into_owned(),
        ],
        Zeroizing::new(Vec::new()),
        Duration::from_secs(120),
    )?;
    Ok(())
}
