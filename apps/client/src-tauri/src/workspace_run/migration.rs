use serde_json::{Map, Value};

use super::model::RUN_SCHEMA_VERSION;

pub(super) fn migrate_version_one(mut document: Value) -> Result<Value, String> {
    let object = document
        .as_object_mut()
        .ok_or("Run configuration must be an object.")?;
    let primary_id = match object.remove("primaryConfigurationId") {
        Some(Value::String(id)) => Some(id),
        Some(Value::Null) | None => None,
        _ => return Err("Run primaryConfigurationId must be a string or null.".to_string()),
    };
    let configurations = object
        .get_mut("configurations")
        .and_then(Value::as_array_mut)
        .ok_or("Run configurations must be an array.")?;
    if let Some(id) = &primary_id {
        if !configurations
            .iter()
            .any(|configuration| configuration.get("id").and_then(Value::as_str) == Some(id))
        {
            return Err(format!("Primary run configuration `{id}` does not exist."));
        }
    }
    for configuration in configurations {
        let configuration = configuration
            .as_object_mut()
            .ok_or("Run configuration must be an object.")?;
        if configuration.contains_key("primary") {
            return Err("Run schemaVersion 1 cannot contain primary flags.".to_string());
        }
        let primary = primary_id
            .as_deref()
            .is_some_and(|id| configuration.get("id").and_then(Value::as_str) == Some(id));
        configuration.insert("primary".to_string(), Value::Bool(primary));
        match configuration.get("kind").and_then(Value::as_str) {
            Some("task") => {
                for (old, current) in [
                    ("working_directory", "workingDirectory"),
                    ("hot_reload", "hotReload"),
                    ("health_check", "healthCheck"),
                    ("restart_policy", "restartPolicy"),
                ] {
                    rename_field(configuration, old, current)?;
                }
                if let Some(health_check) = configuration
                    .get_mut("healthCheck")
                    .and_then(Value::as_object_mut)
                {
                    for field in [
                        "startupDelayMs",
                        "intervalMs",
                        "timeoutMs",
                        "failureThreshold",
                    ] {
                        health_check.remove(field);
                    }
                }
            }
            Some("composite") => rename_field(configuration, "start_order", "startOrder")?,
            _ => return Err("Run configuration kind must be task or composite.".to_string()),
        }
    }
    object.insert("schemaVersion".to_string(), RUN_SCHEMA_VERSION.into());
    Ok(document)
}

fn rename_field(object: &mut Map<String, Value>, old: &str, current: &str) -> Result<(), String> {
    if let Some(value) = object.remove(old) {
        if object.contains_key(current) {
            return Err(format!(
                "Run configuration contains both `{old}` and `{current}`."
            ));
        }
        object.insert(current.to_string(), value);
    }
    Ok(())
}
