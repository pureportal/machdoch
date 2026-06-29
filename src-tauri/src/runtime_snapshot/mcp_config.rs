use std::{fs, path::PathBuf};

use super::{get_user_config_directory, resolve_workspace_root_path, settings::McpConfigDocument};

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
    }

    fs::write(&config_path, &normalized_raw)
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;

    Ok(McpConfigDocument {
        scope: scope.to_string(),
        path: config_path.display().to_string(),
        exists: true,
        raw: normalized_raw,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

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
}
