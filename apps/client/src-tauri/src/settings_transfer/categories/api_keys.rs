use serde_json::{json, Value};

use super::{
    create_json_snapshot, load_user_config_value, object_or_empty, require_exact_keys,
    validate_string_map, CategorySnapshot, SettingsCategoryId, MAX_TOTAL_ITEMS, USER_API_PROVIDERS,
    USER_WEB_SEARCH_PROVIDERS,
};

pub(super) fn snapshot() -> Result<CategorySnapshot, String> {
    let root = load_user_config_value()?;
    let root = root
        .as_object()
        .ok_or_else(|| "Global user settings are invalid.".to_string())?;
    let api_keys = object_or_empty(root.get("apiKeys"));
    let web_search = object_or_empty(root.get("webSearch"));
    let web_search_keys = object_or_empty(web_search.get("apiKeys"));

    for value in api_keys.values().chain(web_search_keys.values()) {
        if !value.is_string() {
            return Err("A persisted API-key entry has an invalid value.".to_string());
        }
    }

    let count = api_keys.len().saturating_add(web_search_keys.len());
    create_json_snapshot(
        SettingsCategoryId::ApiKeys,
        json!({
            "apiKeys": api_keys,
            "webSearchApiKeys": web_search_keys,
        }),
        u32::try_from(count).unwrap_or(u32::MAX),
        count == 0,
    )
}

pub(super) fn validate(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "The API-key category is invalid.".to_string())?;
    require_exact_keys(root, &["apiKeys", "webSearchApiKeys"])?;
    let count = validate_string_map(root.get("apiKeys"), &USER_API_PROVIDERS)?.saturating_add(
        validate_string_map(root.get("webSearchApiKeys"), &USER_WEB_SEARCH_PROVIDERS)?,
    );
    if count > MAX_TOTAL_ITEMS {
        return Err("The API-key category contains too many entries.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_schema_is_closed_and_requires_string_values() {
        assert!(validate(&json!({
            "apiKeys": { "openai": "secret" },
            "webSearchApiKeys": {}
        }))
        .is_ok());
        assert!(validate(&json!({
            "apiKeys": { "openai": 12 },
            "webSearchApiKeys": {}
        }))
        .is_err());
        assert!(validate(&json!({
            "apiKeys": {},
            "webSearchApiKeys": {},
            "workspaceRoot": "poison"
        }))
        .is_err());
        assert!(validate(&json!({
            "apiKeys": { "future-provider": "secret" },
            "webSearchApiKeys": {}
        }))
        .is_err());
    }
}
