use std::fs;

use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::{
    create_json_snapshot, path_entry_exists, verify_regular_contained_file, MAX_MCP_BYTES,
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
        verify_regular_contained_file(&root, &path, MAX_MCP_BYTES)?;
        let raw = Zeroizing::new(fs::read_to_string(&path).map_err(|_| {
            "The global MCP configuration must contain valid UTF-8 text.".to_string()
        })?);
        if raw.len() as u64 > MAX_MCP_BYTES {
            return Err("The global MCP configuration exceeds the transfer limit.".to_string());
        }
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
