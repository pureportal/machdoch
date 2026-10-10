use std::{fs, io::ErrorKind, path::Path, time::Duration};

use zeroize::Zeroizing;

pub(crate) fn ensure_workspace_storage(workspace_root: &Path) -> Result<(), String> {
    let directory = workspace_root.join(".machdoch");
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
                if !workspace_gitignore_needs_update(workspace_root)? {
                    return Ok(());
                }
            } else {
                return Err("Unsupported workspace storage layout.".to_string());
            }
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

fn read_regular_file(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => Err(format!(
            "Workspace storage must be a regular file: {}",
            path.display()
        )),
        Ok(_) => fs::read_to_string(path)
            .map(Some)
            .map_err(|error| format!("Failed to read {}: {error}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
    }
}

fn workspace_gitignore_needs_update(workspace_root: &Path) -> Result<bool, String> {
    let directory = workspace_root.join(".machdoch");
    if let Some(raw) = read_regular_file(&directory.join("config.json"))? {
        let config: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|error| format!("Invalid workspace config: {error}"))?;
        let config = config
            .as_object()
            .ok_or_else(|| "Expected workspace config to be a JSON object.".to_string())?;
        if let Some(value) = config.get("autoGitignore") {
            match value.as_bool() {
                Some(false) => return Ok(false),
                Some(true) => {}
                None => return Err("Expected autoGitignore to be a boolean.".to_string()),
            }
        }
    }
    let content = read_regular_file(&directory.join(".gitignore"))?.unwrap_or_default();
    Ok(["/local/", "*.machdoch.lock*/", "*.json.lock/", "*.tmp"]
        .iter()
        .any(|pattern| !content.lines().any(|line| line.trim() == *pattern)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn ignore_check_honors_workspace_config_and_missing_rules() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("machdoch-gitignore-check-{unique}"));
        let directory = root.join(".machdoch");
        fs::create_dir_all(&directory).unwrap();
        assert!(workspace_gitignore_needs_update(&root).unwrap());
        let ignore_path = directory.join(".gitignore");
        fs::write(
            &ignore_path,
            "/local/\r\n*.machdoch.lock*/\r\n*.json.lock/\r\n*.tmp\r\n",
        )
        .unwrap();
        assert!(!workspace_gitignore_needs_update(&root).unwrap());
        fs::write(&ignore_path, "/local/\n").unwrap();
        assert!(workspace_gitignore_needs_update(&root).unwrap());
        let config_path = directory.join("config.json");
        fs::write(&config_path, r#"{"autoGitignore":false}"#).unwrap();
        assert!(!workspace_gitignore_needs_update(&root).unwrap());
        fs::write(&config_path, r#"{"autoGitignore":true}"#).unwrap();
        assert!(workspace_gitignore_needs_update(&root).unwrap());
        fs::write(&config_path, r#"{"autoGitignore":"false"}"#).unwrap();
        assert!(workspace_gitignore_needs_update(&root)
            .unwrap_err()
            .contains("boolean"));
        fs::remove_dir_all(root).unwrap();
    }
}
