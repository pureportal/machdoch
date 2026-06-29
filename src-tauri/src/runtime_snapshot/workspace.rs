use std::{
    env as std_env, fs,
    path::{Path, PathBuf},
};

use super::settings::WorkspaceConfigFile;
use super::{is_valid_mode, is_valid_reasoning_mode, normalize_optional_string};

pub(crate) fn get_user_config_directory() -> Result<PathBuf, String> {
    if let Some(override_directory) =
        normalize_optional_string(std_env::var("MACHDOCH_USER_CONFIG_DIR").ok().as_deref())
    {
        return Ok(PathBuf::from(override_directory));
    }

    #[cfg(target_os = "windows")]
    {
        let base_directory = std_env::var("APPDATA")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std_env::var("USERPROFILE")
                    .ok()
                    .map(|path| PathBuf::from(path).join("AppData").join("Roaming"))
            })
            .ok_or_else(|| {
                "Unable to determine the Windows roaming config directory.".to_string()
            })?;

        Ok(base_directory.join("machdoch"))
    }

    #[cfg(target_os = "macos")]
    {
        let home_directory = std_env::var("HOME")
            .ok()
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to determine the macOS home directory.".to_string())?;

        return Ok(home_directory
            .join("Library")
            .join("Application Support")
            .join("machdoch"));
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let base_directory = std_env::var("XDG_CONFIG_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std_env::var("HOME")
                    .ok()
                    .map(|path| PathBuf::from(path).join(".config"))
            })
            .ok_or_else(|| "Unable to determine the XDG config directory.".to_string())?;

        Ok(base_directory.join("machdoch"))
    }
}

fn get_default_workspace_root() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        std_env::var("USERPROFILE")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                let drive = normalize_optional_string(std_env::var("HOMEDRIVE").ok().as_deref())?;
                let path = normalize_optional_string(std_env::var("HOMEPATH").ok().as_deref())?;

                Some(PathBuf::from(format!("{drive}{path}")))
            })
            .or_else(|| std_env::var("HOME").ok().map(PathBuf::from))
            .ok_or_else(|| {
                "Unable to determine the Windows home directory for the default workspace."
                    .to_string()
            })
    }

    #[cfg(not(target_os = "windows"))]
    {
        std_env::var("HOME").ok().map(PathBuf::from).ok_or_else(|| {
            "Unable to determine the home directory for the default workspace.".to_string()
        })
    }
}

pub(crate) fn resolve_workspace_root_path(workspace_root: &str) -> Result<PathBuf, String> {
    let candidate_workspace_path = normalize_optional_string(Some(workspace_root))
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(get_default_workspace_root)?;

    if !candidate_workspace_path.exists() || !candidate_workspace_path.is_dir() {
        return Err(format!(
            "Workspace `{}` does not exist or is not a directory.",
            candidate_workspace_path.display()
        ));
    }

    candidate_workspace_path.canonicalize().map_err(|error| {
        format!(
            "Unable to resolve workspace `{}`: {error}",
            candidate_workspace_path.display()
        )
    })
}

pub(super) fn load_workspace_config(
    workspace_root: &Path,
) -> Result<(WorkspaceConfigFile, Option<String>), String> {
    let config_path = workspace_root.join(".machdoch").join("config.json");

    if !config_path.exists() {
        return Ok((WorkspaceConfigFile::default(), None));
    }

    let raw = fs::read_to_string(&config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    let parsed = serde_json::from_str::<WorkspaceConfigFile>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;

    Ok((parsed, Some(config_path.display().to_string())))
}

fn load_workspace_config_json(
    config_path: &Path,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    if !config_path.exists() {
        return Ok(serde_json::Map::new());
    }

    let raw = fs::read_to_string(config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;

    match parsed {
        serde_json::Value::Object(config) => Ok(config),
        _ => Err(format!(
            "Expected workspace config {} to be a JSON object.",
            config_path.display()
        )),
    }
}

fn write_workspace_config_json(
    config_path: &Path,
    config: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
    }

    let serialized = serde_json::to_string_pretty(&serde_json::Value::Object(config.clone()))
        .map_err(|error| format!("Failed to serialize workspace config: {error}"))?;

    fs::write(config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))
}

pub(super) fn save_workspace_default_mode_value(
    workspace_root: &str,
    mode: &str,
) -> Result<PathBuf, String> {
    let normalized_mode = normalize_optional_string(Some(mode))
        .ok_or_else(|| "Expected workspace mode to be one of ask or machdoch.".to_string())?;

    if !is_valid_mode(Some(normalized_mode.as_str())) {
        return Err("Expected workspace mode to be one of ask or machdoch.".to_string());
    }

    let workspace_path = resolve_workspace_root_path(workspace_root)?;
    let config_path = workspace_path.join(".machdoch").join("config.json");
    let mut config = load_workspace_config_json(&config_path)?;

    config.insert(
        "defaultMode".to_string(),
        serde_json::Value::String(normalized_mode),
    );
    write_workspace_config_json(&config_path, &config)?;

    Ok(config_path)
}

pub(super) fn save_workspace_reasoning_mode_value(
    workspace_root: &str,
    reasoning: &str,
) -> Result<PathBuf, String> {
    let normalized_reasoning = normalize_optional_string(Some(reasoning)).ok_or_else(|| {
        "Expected workspace reasoning to be one of default, none, minimal, low, medium, high, xhigh, or max.".to_string()
    })?;

    if !is_valid_reasoning_mode(Some(normalized_reasoning.as_str())) {
        return Err(
            "Expected workspace reasoning to be one of default, none, minimal, low, medium, high, xhigh, or max."
                .to_string(),
        );
    }

    let workspace_path = resolve_workspace_root_path(workspace_root)?;
    let config_path = workspace_path.join(".machdoch").join("config.json");
    let mut config = load_workspace_config_json(&config_path)?;

    config.insert(
        "reasoning".to_string(),
        serde_json::Value::String(normalized_reasoning),
    );
    write_workspace_config_json(&config_path, &config)?;

    Ok(config_path)
}
