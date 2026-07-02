use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};

use super::{
    get_user_config_directory, resolve_workspace_root_path, settings_types::McpConfigDocument,
};

const MCP_CONFIG_FILE_NAME: &str = "mcp.json";
const MCP_WORKSPACE_CONFIG_DIRECTORY: [&str; 2] = [".machdoch", "mcp"];

pub(super) fn get_user_mcp_config_path() -> Result<PathBuf, String> {
    Ok(get_user_config_directory()?.join(MCP_CONFIG_FILE_NAME))
}

pub(super) fn get_workspace_mcp_config_path(workspace_root: &str) -> Result<PathBuf, String> {
    let workspace_path = resolve_workspace_root_path(workspace_root)?;

    Ok(workspace_path
        .join(MCP_WORKSPACE_CONFIG_DIRECTORY[0])
        .join(MCP_WORKSPACE_CONFIG_DIRECTORY[1])
        .join(MCP_CONFIG_FILE_NAME))
}

fn create_default_mcp_config_raw() -> Result<String, String> {
    let value = serde_json::json!({
        "schemaVersion": 1,
        "defaults": {
            "enabled": true,
            "securityProfile": "weak",
            "exposure": "hybrid",
            "directTools": true,
            "timeoutMs": 60000,
            "maxTotalTimeoutMs": 300000,
            "idleShutdownMs": 900000,
            "maxResponseChars": 60000,
            "cache": {
                "enabled": true,
                "ttlMs": 900000,
                "forceRefresh": false
            },
            "roots": "workspace",
            "sampling": "disabled",
            "tasks": "optional",
            "elicitation": "disabled"
        },
        "servers": []
    });
    let serialized = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to serialize default MCP config: {error}"))?;

    Ok(format!("{serialized}\n"))
}

fn normalize_mcp_config_raw(raw: &str) -> Result<String, String> {
    let parsed = serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|error| format!("MCP config must be valid JSON: {error}"))?;

    if !parsed.is_object() {
        return Err("MCP config must be a JSON object.".to_string());
    }

    let serialized = serde_json::to_string_pretty(&parsed)
        .map_err(|error| format!("Failed to serialize MCP config: {error}"))?;

    Ok(format!("{serialized}\n"))
}

pub(super) fn load_mcp_config_document(
    scope: &str,
    config_path: PathBuf,
) -> Result<McpConfigDocument, String> {
    let exists = config_path.exists();
    let raw = if exists {
        fs::read_to_string(&config_path)
            .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?
    } else {
        create_default_mcp_config_raw()?
    };

    Ok(McpConfigDocument {
        scope: scope.to_string(),
        path: config_path.display().to_string(),
        exists,
        raw,
    })
}

pub(super) fn save_mcp_config_document(
    scope: &str,
    config_path: PathBuf,
    raw: &str,
) -> Result<McpConfigDocument, String> {
    let normalized_raw = normalize_mcp_config_raw(raw)?;

    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
        if scope == "user" {
            secure_user_mcp_config_directory(config_directory)?;
        }
    }

    let write_options = if scope == "user" {
        AtomicWriteOptions::with_unix_mode(0o600)
    } else {
        AtomicWriteOptions::default()
    };

    write_file_atomic(&config_path, normalized_raw.as_bytes(), write_options)
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;

    if scope == "user" {
        secure_user_mcp_config_file(&config_path)?;
    }

    Ok(McpConfigDocument {
        scope: scope.to_string(),
        path: config_path.display().to_string(),
        exists: true,
        raw: normalized_raw,
    })
}

fn secure_user_mcp_config_directory(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }

    Ok(())
}

fn secure_user_mcp_config_file(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn temp_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();

        std::env::temp_dir().join(format!("machdoch-mcp-config-{name}-{unique}"))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn default_mcp_config_is_pretty_json_object() {
        let raw = create_default_mcp_config_raw().expect("default MCP config should serialize");
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).expect("default MCP config should be valid JSON");

        assert!(raw.ends_with('\n'));
        assert_eq!(parsed["schemaVersion"], 1);
        assert_eq!(parsed["defaults"]["enabled"], true);
        assert!(parsed["servers"].is_array());
    }

    #[test]
    fn mcp_config_normalization_rejects_non_object_json() {
        let error = normalize_mcp_config_raw("[]").expect_err("arrays should be rejected");

        assert_eq!(error, "MCP config must be a JSON object.");
    }

    #[test]
    fn mcp_config_save_normalizes_and_loads_existing_document() {
        let directory = temp_test_directory("round-trip");
        let config_path = directory.join(".machdoch").join("mcp").join("mcp.json");

        let saved = save_mcp_config_document("workspace", config_path.clone(), r#"{"servers":[]}"#)
            .expect("MCP config should save");
        let loaded =
            load_mcp_config_document("workspace", config_path).expect("MCP config should load");

        assert!(saved.exists);
        assert!(loaded.exists);
        assert_eq!(loaded.scope, "workspace");
        assert_eq!(saved.raw, loaded.raw);
        assert!(loaded.raw.contains("\"servers\": []"));

        cleanup(&directory);
    }

    #[cfg(unix)]
    #[test]
    fn user_mcp_config_save_secures_directory_and_file_permissions() {
        let directory = temp_test_directory("user-permissions");
        let config_path = directory.join("user-config").join("mcp.json");

        let saved = save_mcp_config_document("user", config_path.clone(), r#"{"servers":[]}"#)
            .expect("user MCP config should save");

        let config_directory = config_path
            .parent()
            .expect("MCP config path should have a parent directory");
        let directory_mode = fs::metadata(config_directory)
            .expect("config directory metadata should be readable")
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(&config_path)
            .expect("config file metadata should be readable")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(saved.scope, "user");
        assert!(saved.raw.ends_with('\n'));
        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);

        cleanup(&directory);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_mcp_config_save_does_not_change_existing_directory_permissions() {
        let directory = temp_test_directory("workspace-permissions");
        let config_directory = directory.join(".machdoch").join("mcp");
        let config_path = config_directory.join("mcp.json");
        fs::create_dir_all(&config_directory).expect("workspace MCP directory should be created");
        let mut permissions = fs::metadata(&config_directory)
            .expect("workspace MCP directory metadata should be readable")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&config_directory, permissions)
            .expect("workspace MCP directory permissions should be set");

        save_mcp_config_document("workspace", config_path, r#"{"servers":[]}"#)
            .expect("workspace MCP config should save");

        let directory_mode = fs::metadata(&config_directory)
            .expect("workspace MCP directory metadata should still be readable")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(directory_mode, 0o755);

        cleanup(&directory);
    }
}
