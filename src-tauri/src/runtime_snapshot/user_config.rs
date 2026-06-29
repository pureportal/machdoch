use std::{
    fs,
    path::{Path, PathBuf},
};

use super::{get_user_config_directory, settings::UserConfigFile};

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
    }

    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize user config: {error}"))?;

    fs::write(config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))
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

        std::env::temp_dir().join(format!("machdoch-user-config-{name}-{unique}"))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn user_config_write_creates_parent_directory_and_trailing_newline() {
        let directory = temp_test_directory("write");
        let config_path = directory.join("nested").join("user-config.json");
        let config = UserConfigFile::default();

        write_user_config_file(&config, &config_path).expect("user config should write");

        let raw = fs::read_to_string(&config_path).expect("user config should be readable");
        assert!(raw.ends_with('\n'));
        assert!(raw.contains("\"apiKeys\""));

        cleanup(&directory);
    }
}
