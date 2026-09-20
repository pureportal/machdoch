use serde_json::{json, Value};
use tauri::Manager;
use tauri_plugin_store::StoreExt;

const KEY: &str = "machdoch.desktop.media-studio-state";

pub(super) fn execute(app: &tauri::AppHandle, command: &str, args: &Value) -> Result<Value, Value> {
    let store = app
        .store("machdoch-shell-state.json")
        .map_err(|error| json!(error.to_string()))?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| json!(error.to_string()))?
        .join("machdoch-shell-state.json");
    if path.exists() {
        store.reload().map_err(|error| json!(error.to_string()))?;
    }
    if command == "media_read_studio_state" {
        return Ok(store.get(KEY).unwrap_or(Value::Null));
    }
    let value = args
        .get("value")
        .filter(|value| value.is_object())
        .ok_or_else(|| json!("Expected Media Studio state."))?;
    store.set(KEY, value.clone());
    store.save().map_err(|error| json!(error.to_string()))?;
    Ok(Value::Null)
}
