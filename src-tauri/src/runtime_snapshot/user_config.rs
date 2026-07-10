use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};
use crate::cooperative_file_lock::with_cooperative_file_lock;

use super::{get_user_config_directory, settings_types::UserConfigFile};

const USER_CONFIG_FILE_NAME: &str = "user-config.json";

pub(super) fn get_user_config_path() -> Result<PathBuf, String> {
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

pub(super) fn update_user_config_file(
    update: impl FnOnce(&mut UserConfigFile),
) -> Result<PathBuf, String> {
    let config_path = get_user_config_path()?;

    with_cooperative_file_lock(&config_path, || {
        let (mut config, loaded_path) = load_user_config_file()?;
        update(&mut config);
        write_user_config_file(&config, &loaded_path)?;
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
}
