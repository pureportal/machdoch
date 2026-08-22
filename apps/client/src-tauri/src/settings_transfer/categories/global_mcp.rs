use std::{collections::HashSet, fs};

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt as _;
use zeroize::Zeroizing;

use super::{
    create_json_snapshot, path_entry_exists, required_trimmed_string,
    verify_regular_contained_file, MAX_MCP_BYTES, MCP_MARKETPLACE_STORAGE_KEY, STORE_FILE,
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

pub(super) fn normalize_marketplace(value: Option<Value>) -> Result<Value, String> {
    let root = value.as_ref().and_then(Value::as_object);
    let entries = root
        .and_then(|value| value.get("registries"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = HashSet::new();
    let mut registries = Vec::new();
    for entry in entries {
        let object = entry
            .as_object()
            .ok_or_else(|| "An MCP marketplace registry is invalid.".to_string())?;
        let id = required_trimmed_string(object.get("id"), "An MCP registry is missing its id.")?;
        let title =
            required_trimmed_string(object.get("title"), "An MCP registry is missing its title.")?;
        let base_url =
            required_trimmed_string(object.get("baseUrl"), "An MCP registry is missing its URL.")?;
        let parsed = reqwest::Url::parse(&base_url)
            .map_err(|_| "An MCP registry URL is invalid.".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("An MCP registry URL must use HTTP or HTTPS.".to_string());
        }
        if !seen.insert(id.to_lowercase()) {
            return Err("MCP registry ids must be unique.".to_string());
        }
        registries.push(json!({
            "id": id,
            "title": title,
            "baseUrl": base_url,
            "enabled": object.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        }));
    }
    Ok(json!({ "version": 1, "registries": registries }))
}

pub(super) fn snapshot<R: Runtime>(app: &AppHandle<R>) -> Result<CategorySnapshot, String> {
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
    let store = app
        .store(STORE_FILE)
        .map_err(|_| "MCP registry settings are unavailable.".to_string())?;
    let marketplace = normalize_marketplace(store.get(MCP_MARKETPLACE_STORAGE_KEY))?;
    let registry_count = marketplace["registries"].as_array().map_or(0, Vec::len);
    let server_count = config
        .get("servers")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let empty = !exists && registry_count == 0;
    create_json_snapshot(
        SettingsCategoryId::GlobalMcp,
        json!({ "exists": exists, "config": config, "marketplace": marketplace }),
        u32::try_from(server_count.saturating_add(registry_count)).unwrap_or(u32::MAX),
        empty,
    )
}
