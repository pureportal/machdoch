use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::{
    create_json_snapshot, path_entry_exists, read_verified_text_file,
    verify_regular_contained_file, SnapshotTextReadError, MAX_MCP_BYTES,
};
use crate::{
    runtime_snapshot::get_user_config_directory,
    settings_transfer::contract::{CategorySnapshot, SettingsCategoryId},
};

mod validation;

pub(super) fn validate_config(value: &Value) -> Result<(), String> {
    validation::validate_config(value)
}

pub(super) fn validate(value: &Value) -> Result<(), String> {
    validation::validate(value)
}

pub(super) fn snapshot() -> Result<CategorySnapshot, String> {
    let root = get_user_config_directory()?;
    let path = root.join("mcp.json");
    let exists = path_entry_exists(&path)?;
    let config = if exists {
        let expected_bytes = verify_regular_contained_file(&root, &path, MAX_MCP_BYTES)?;
        let raw = Zeroizing::new(
            read_verified_text_file(&path, expected_bytes, MAX_MCP_BYTES).map_err(|error| {
                match error {
                    SnapshotTextReadError::ChangedDuringRead => {
                        "The global MCP configuration changed while it was being read.".to_string()
                    }
                    SnapshotTextReadError::ExceedsLimit => {
                        "The global MCP configuration exceeds the transfer limit.".to_string()
                    }
                    SnapshotTextReadError::Read | SnapshotTextReadError::InvalidUtf8 => {
                        "The global MCP configuration must contain valid UTF-8 text.".to_string()
                    }
                }
            })?,
        );
        serde_json::from_str::<Value>(&raw)
            .map_err(|_| "The global MCP configuration is invalid JSON.".to_string())?
    } else {
        json!({})
    };
    validate_config(&config)?;
    let server_count = config
        .get("servers")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    create_json_snapshot(
        SettingsCategoryId::GlobalMcp,
        json!({ "exists": exists, "config": config }),
        u32::try_from(server_count).unwrap_or(u32::MAX),
        !exists,
    )
}
