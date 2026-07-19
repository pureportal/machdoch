use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};
use crate::cooperative_file_lock::with_cooperative_file_lock;
use serde_json::{Map, Value};
use zeroize::Zeroizing;

use super::{get_user_config_directory, settings_types::UserConfigFile};

const USER_CONFIG_FILE_NAME: &str = "user-config.json";

pub(crate) fn get_user_config_path() -> Result<PathBuf, String> {
    Ok(get_user_config_directory()?.join(USER_CONFIG_FILE_NAME))
}

pub(super) fn load_user_config_file() -> Result<(UserConfigFile, PathBuf), String> {
    let config_path = get_user_config_path()?;

    if !config_path.exists() {
        return Ok((UserConfigFile::default(), config_path));
    }

    let raw = fs::read_to_string(&config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    let parsed = serde_json::from_str::<UserConfigFile>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;

    Ok((parsed, config_path))
}

#[cfg(test)]
pub(super) fn write_user_config_file(
    config: &UserConfigFile,
    config_path: &Path,
) -> Result<(), String> {
    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
        secure_user_config_directory(config_directory)?;
    }

    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize user config: {error}"))?;

    let raw = format!("{serialized}\n");
    write_file_atomic(
        config_path,
        raw.as_bytes(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;
    secure_user_config_file(config_path)
}

pub(crate) fn load_user_config_value_at_path(config_path: &Path) -> Result<Value, String> {
    if !config_path.exists() {
        return Ok(Value::Object(Map::new()));
    }

    let raw = Zeroizing::new(
        fs::read_to_string(config_path)
            .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?,
    );
    let parsed = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;

    if !parsed.is_object() {
        return Err(format!(
            "Expected user config {} to be a JSON object.",
            config_path.display()
        ));
    }

    Ok(parsed)
}

pub(crate) fn write_user_config_value_at_path(
    config: &Value,
    config_path: &Path,
) -> Result<(), String> {
    if !config.is_object() {
        return Err("Expected user config to be a JSON object.".to_string());
    }

    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
        secure_user_config_directory(config_directory)?;
    }

    let mut raw = Zeroizing::new(
        serde_json::to_vec_pretty(config)
            .map_err(|error| format!("Failed to serialize user config: {error}"))?,
    );
    raw.push(b'\n');
    write_file_atomic(
        config_path,
        raw.as_slice(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;
    secure_user_config_file(config_path)
}

fn replace_object_member(target: &mut Map<String, Value>, source: &Map<String, Value>, key: &str) {
    match source.get(key) {
        Some(value) => {
            target.insert(key.to_string(), value.clone());
        }
        None => {
            target.remove(key);
        }
    }
}

fn merge_known_object_members(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    key: &str,
    members: &[&str],
) {
    let source_object = source.get(key).and_then(Value::as_object);
    let target_value = target
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));

    if !target_value.is_object() {
        *target_value = Value::Object(Map::new());
    }

    let target_object = target_value
        .as_object_mut()
        .expect("the target value was normalized to an object");
    for member in members {
        match source_object.and_then(|value| value.get(*member)) {
            Some(value) => {
                target_object.insert((*member).to_string(), value.clone());
            }
            None => {
                target_object.remove(*member);
            }
        }
    }
}

/// Applies the fields understood by the current Rust settings model while
/// retaining every unknown top-level and nested member. This prevents a save
/// from erasing settings added by newer TypeScript schemas (for example
/// `providerEnrollment`) and keeps transfer imports forward compatible.
fn merge_typed_user_config(original: Value, typed: &UserConfigFile) -> Result<Value, String> {
    let mut target = original
        .as_object()
        .cloned()
        .ok_or_else(|| "Expected user config to be a JSON object.".to_string())?;
    let serialized = serde_json::to_value(typed)
        .map_err(|error| format!("Failed to serialize user config: {error}"))?;
    let source = serialized
        .as_object()
        .ok_or_else(|| "Failed to serialize user config as an object.".to_string())?;

    replace_object_member(&mut target, source, "apiKeys");
    replace_object_member(&mut target, source, "agentCliPaths");
    merge_known_object_members(
        &mut target,
        source,
        "webSearch",
        &["activeProvider", "apiKeys"],
    );
    merge_known_object_members(&mut target, source, "voice", &["activeProvider"]);
    merge_known_object_members(
        &mut target,
        source,
        "speechToText",
        &["activeProvider", "inputDeviceId"],
    );
    merge_known_object_members(
        &mut target,
        source,
        "desktop",
        &[
            "autostartMinimized",
            "autostartToTray",
            "alwaysRunAsAdministrator",
            "assistantBubbleEnabled",
            "assistantBubbleHideWhenFullscreen",
            "assistantBubbleTemporarilyHideSeconds",
            "aiContextMaxMessages",
            "inactiveSessionArchiveDays",
            "archivedSessionRetentionDays",
            "quickVoiceEnabled",
            "quickVoiceShortcut",
            "quickVoiceSilenceSeconds",
            "quickVoiceMaxMessages",
        ],
    );
    merge_known_object_members(
        &mut target,
        source,
        "agentLimits",
        &["infinite", "executorTurns", "autopilotExecutorIterations"],
    );
    merge_known_object_members(&mut target, source, "memory", &["globalEnabled", "entries"]);
    merge_known_object_members(
        &mut target,
        source,
        "reviewModel",
        &["mode", "provider", "model"],
    );

    Ok(Value::Object(target))
}

pub(super) fn update_user_config_file(
    update: impl FnOnce(&mut UserConfigFile),
) -> Result<PathBuf, String> {
    let config_path = get_user_config_path()?;

    with_cooperative_file_lock(&config_path, || {
        let original = load_user_config_value_at_path(&config_path)?;
        let (mut config, loaded_path) = load_user_config_file()?;
        update(&mut config);
        let merged = merge_typed_user_config(original, &config)?;
        write_user_config_value_at_path(&merged, &loaded_path)?;
        Ok(loaded_path)
    })
}

fn secure_user_config_directory(path: &Path) -> Result<(), String> {
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

fn secure_user_config_file(path: &Path) -> Result<(), String> {
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

        std::env::temp_dir().join(format!("machdoch-user-config-{name}-{unique}"))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn user_config_write_creates_parent_directory_and_trailing_newline() {
        let directory = temp_test_directory("write");
        let config_path = directory.join("nested").join("user-config.json");
        let mut config = UserConfigFile::default();
        config
            .api_keys
            .insert("openai".to_string(), "provider-key".to_string());
        config
            .web_search
            .api_keys
            .insert("perplexity".to_string(), "web-search-key".to_string());

        write_user_config_file(&config, &config_path).expect("user config should write");

        let raw = fs::read_to_string(&config_path).expect("user config should be readable");
        assert!(raw.ends_with('\n'));
        let parsed = serde_json::from_str::<serde_json::Value>(&raw)
            .expect("user config should contain valid JSON");
        assert_eq!(parsed["apiKeys"]["openai"], "provider-key");
        assert_eq!(
            parsed["webSearch"]["apiKeys"]["perplexity"],
            "web-search-key"
        );

        cleanup(&directory);
    }

    #[cfg(unix)]
    #[test]
    fn user_config_write_secures_directory_and_file_permissions() {
        let directory = temp_test_directory("permissions");
        let config_path = directory.join("nested").join("user-config.json");
        let config = UserConfigFile::default();

        write_user_config_file(&config, &config_path).expect("user config should write");

        let config_directory = config_path
            .parent()
            .expect("user config path should have a parent directory");
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

        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);

        cleanup(&directory);
    }

    #[test]
    fn typed_update_preserves_unknown_top_level_and_nested_members() {
        let original = serde_json::json!({
            "apiKeys": { "openai": "old" },
            "desktop": {
                "assistantBubbleEnabled": true,
                "futurePortableSetting": "keep-me"
            },
            "providerEnrollment": {
                "schemaVersion": 1,
                "enabled": true
            },
            "futureRoot": { "nested": true }
        });
        let mut typed: UserConfigFile =
            serde_json::from_value(original.clone()).expect("known settings should parse");
        typed
            .api_keys
            .insert("openai".to_string(), "new".to_string());
        typed.desktop.assistant_bubble_enabled = Some(false);

        let merged = merge_typed_user_config(original, &typed).expect("merge should succeed");

        assert_eq!(merged["apiKeys"]["openai"], "new");
        assert_eq!(merged["desktop"]["assistantBubbleEnabled"], false);
        assert_eq!(merged["desktop"]["futurePortableSetting"], "keep-me");
        assert_eq!(merged["providerEnrollment"]["enabled"], true);
        assert_eq!(merged["futureRoot"]["nested"], true);
    }
}
