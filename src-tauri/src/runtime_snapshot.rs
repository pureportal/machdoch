use std::{
    collections::HashMap,
    env,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

const DEFAULT_MODEL: &str = "gpt-5.4-mini";
const DEFAULT_TOOLS: [&str; 2] = ["filesystem", "shell"];
const PLACEHOLDER_TOKENS: [&str; 3] = ["YOUR_", "CHANGE_ME", "PLACEHOLDER"];
const USER_CONFIG_FILE_NAME: &str = "user-config.json";
const VALID_TOOLS: [&str; 6] = [
    "filesystem",
    "shell",
    "network",
    "browser",
    "git",
    "packages",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCompatibilitySnapshot {
    discover_github_customizations: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    workspace_root: String,
    workspace_config_path: Option<String>,
    active_profile: Option<String>,
    available_profiles: Vec<RuntimeProfileSummary>,
    mode: String,
    enabled_tools: Vec<String>,
    provider: String,
    model: String,
    offline: bool,
    compatibility: RuntimeCompatibilitySnapshot,
    provider_availability: Vec<ProviderAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileSummary {
    name: String,
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAvailability {
    provider: String,
    configured: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceConfigFile {
    default_profile: Option<String>,
    default_mode: Option<String>,
    enabled_tools: Option<Vec<String>>,
    provider: Option<String>,
    model: Option<String>,
    offline: Option<bool>,
    compatibility: Option<WorkspaceCompatibilityConfig>,
    #[serde(default)]
    profiles: HashMap<String, WorkspaceProfileConfig>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCompatibilityConfig {
    discover_github_customizations: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceProfileConfig {
    description: Option<String>,
    mode: Option<String>,
    enabled_tools: Option<Vec<String>>,
    provider: Option<String>,
    model: Option<String>,
    offline: Option<bool>,
    compatibility: Option<WorkspaceCompatibilityConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UserConfigFile {
    #[serde(default)]
    api_keys: HashMap<String, String>,
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();

    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
}

fn is_supported_provider(provider: &str) -> bool {
    matches!(provider.trim(), "openai" | "anthropic" | "google")
}

fn resolve_user_config_dir() -> Result<PathBuf, String> {
    if let Some(override_dir) = normalize_optional_string(
        env::var("MACHDOCH_USER_CONFIG_DIR").ok().as_deref(),
    ) {
        return Ok(PathBuf::from(override_dir));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = env::var_os("APPDATA") {
            return Ok(PathBuf::from(app_data).join("machdoch"));
        }

        let home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .ok_or_else(|| "Could not determine a user config directory.".to_string())?;

        return Ok(PathBuf::from(home)
            .join("AppData")
            .join("Roaming")
            .join("machdoch"));
    }

    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME")
            .ok_or_else(|| "Could not determine a user config directory.".to_string())?;

        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("machdoch"));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(config_home) = env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(config_home).join("machdoch"));
        }

        let home = env::var_os("HOME")
            .ok_or_else(|| "Could not determine a user config directory.".to_string())?;

        return Ok(PathBuf::from(home).join(".config").join("machdoch"));
    }
}

fn get_user_config_path() -> Result<PathBuf, String> {
    Ok(resolve_user_config_dir()?.join(USER_CONFIG_FILE_NAME))
}

fn load_runtime_env() -> HashMap<String, String> {
    let mut values = HashMap::new();

    for key in [
        "MACHDOCH_MODEL",
        "MACHDOCH_MODE",
        "MACHDOCH_PROFILE",
        "MACHDOCH_OFFLINE",
    ] {
        if let Ok(value) = env::var(key) {
            values.insert(key.to_string(), value);
        }
    }

    values
}

fn load_user_config_file() -> Result<(UserConfigFile, PathBuf), String> {
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

fn load_user_api_keys() -> Result<HashMap<String, String>, String> {
    let (config, _) = load_user_config_file()?;

    Ok(config
        .api_keys
        .into_iter()
        .filter_map(|(provider, value)| {
            let normalized_provider = normalize_optional_string(Some(provider.as_str()))?;
            let normalized_value = normalize_optional_string(Some(value.as_str()))?;

            if !is_supported_provider(&normalized_provider) {
                return None;
            }

            Some((normalized_provider, normalized_value))
        })
        .collect())
}

fn load_workspace_config(
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

fn has_configured_value(value: Option<&str>) -> bool {
    let Some(value) = value.map(str::trim) else {
        return false;
    };

    if value.is_empty() {
        return false;
    }

    !PLACEHOLDER_TOKENS
        .iter()
        .any(|token| value.contains(token))
}

fn get_provider_availability(api_keys: &HashMap<String, String>) -> Vec<ProviderAvailability> {
    vec![
        ProviderAvailability {
            provider: "openai".to_string(),
            configured: has_configured_value(api_keys.get("openai").map(String::as_str)),
        },
        ProviderAvailability {
            provider: "anthropic".to_string(),
            configured: has_configured_value(api_keys.get("anthropic").map(String::as_str)),
        },
        ProviderAvailability {
            provider: "google".to_string(),
            configured: has_configured_value(api_keys.get("google").map(String::as_str)),
        },
    ]
}

fn normalize_tools(tools: Option<&Vec<String>>) -> Vec<String> {
    let Some(tools) = tools else {
        return DEFAULT_TOOLS
            .iter()
            .map(|tool| (*tool).to_string())
            .collect();
    };

    let mut normalized = Vec::new();

    for tool in tools {
        let trimmed = tool.trim();

        if trimmed.is_empty() || normalized.iter().any(|entry| entry == trimmed) {
            continue;
        }

        if VALID_TOOLS.iter().any(|candidate| candidate == &trimmed) {
            normalized.push(trimmed.to_string());
        }
    }

    if normalized.is_empty() {
        DEFAULT_TOOLS
            .iter()
            .map(|tool| (*tool).to_string())
            .collect()
    } else {
        normalized
    }
}

fn resolve_compatibility(
    config: &WorkspaceConfigFile,
    profile: Option<&WorkspaceProfileConfig>,
) -> RuntimeCompatibilitySnapshot {
    RuntimeCompatibilitySnapshot {
        discover_github_customizations: profile
            .and_then(|entry| entry.compatibility.as_ref())
            .and_then(|entry| entry.discover_github_customizations)
            .or(config
                .compatibility
                .as_ref()
                .and_then(|entry| entry.discover_github_customizations))
            .unwrap_or(false),
    }
}

#[tauri::command]
pub async fn get_global_provider_availability() -> Result<Vec<ProviderAvailability>, String> {
    Ok(get_provider_availability(&load_user_api_keys()?))
}

#[tauri::command]
pub async fn set_user_api_key(
    provider: String,
    api_key: String,
) -> Result<Vec<ProviderAvailability>, String> {
    let normalized_provider = normalize_optional_string(Some(provider.as_str()))
        .ok_or_else(|| "Expected a provider name.".to_string())?;
    let normalized_api_key = normalize_optional_string(Some(api_key.as_str()))
        .ok_or_else(|| "Expected a non-empty API key.".to_string())?;

    if !is_supported_provider(&normalized_provider) {
        return Err("Expected provider to be one of openai, anthropic, or google.".to_string());
    }

    let (mut config, config_path) = load_user_config_file()?;

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    config
        .api_keys
        .insert(normalized_provider, normalized_api_key);

    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Failed to serialize {}: {error}", config_path.display()))?;

    fs::write(&config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;

    Ok(get_provider_availability(&load_user_api_keys()?))
}

fn resolve_provider(
    configured_provider: Option<&str>,
    availability: &[ProviderAvailability],
) -> String {
    if let Some(provider) = normalize_optional_string(configured_provider) {
        return provider;
    }

    availability
        .iter()
        .find(|entry| entry.configured)
        .map(|entry| entry.provider.clone())
        .unwrap_or_else(|| "unconfigured".to_string())
}

fn is_valid_mode(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("safe" | "ask" | "auto"))
}

fn get_available_profiles(
    profiles: &HashMap<String, WorkspaceProfileConfig>,
) -> Vec<RuntimeProfileSummary> {
    let mut summaries = profiles
        .iter()
        .map(|(name, profile)| RuntimeProfileSummary {
            name: name.clone(),
            description: normalize_optional_string(profile.description.as_deref()),
        })
        .collect::<Vec<_>>();

    summaries.sort_by(|left, right| left.name.cmp(&right.name));
    summaries
}

fn resolve_profile<'a>(
    config: &'a WorkspaceConfigFile,
    env: &HashMap<String, String>,
) -> Result<(Option<String>, Option<&'a WorkspaceProfileConfig>), String> {
    let requested_profile = normalize_optional_string(
        env.get("MACHDOCH_PROFILE")
            .map(String::as_str)
            .or(config.default_profile.as_deref()),
    );

    let Some(requested_profile) = requested_profile else {
        return Ok((None, None));
    };

    let Some(profile) = config.profiles.get(&requested_profile) else {
        return Err(format!(
            "Profile `{requested_profile}` was not found in .machdoch/config.json."
        ));
    };

    Ok((Some(requested_profile), Some(profile)))
}

#[tauri::command]
pub async fn get_runtime_snapshot(workspace_root: String) -> Result<RuntimeSnapshot, String> {
    let workspace_path = PathBuf::from(&workspace_root);

    if !workspace_path.exists() || !workspace_path.is_dir() {
        return Err(format!(
            "Workspace `{}` does not exist or is not a directory.",
            workspace_root
        ));
    }

    let env = load_runtime_env();
    let user_api_keys = load_user_api_keys()?;
    let (config, workspace_config_path) = load_workspace_config(&workspace_path)?;
    let (active_profile, profile) = resolve_profile(&config, &env)?;
    let provider_availability = get_provider_availability(&user_api_keys);
    let enabled_tools = normalize_tools(
        profile
            .and_then(|entry| entry.enabled_tools.as_ref())
            .or(config.enabled_tools.as_ref()),
    );
    let compatibility = resolve_compatibility(&config, profile);

    let mode = if is_valid_mode(env.get("MACHDOCH_MODE").map(String::as_str)) {
        env.get("MACHDOCH_MODE")
            .map(String::as_str)
            .unwrap_or("ask")
            .trim()
            .to_string()
    } else if is_valid_mode(profile.and_then(|entry| entry.mode.as_deref())) {
        profile
            .and_then(|entry| entry.mode.as_deref())
            .unwrap_or("ask")
            .trim()
            .to_string()
    } else if is_valid_mode(config.default_mode.as_deref()) {
        config
            .default_mode
            .as_deref()
            .unwrap_or("ask")
            .trim()
            .to_string()
    } else {
        "ask".to_string()
    };

    let provider = resolve_provider(
        profile
            .and_then(|entry| entry.provider.as_deref())
            .or(config.provider.as_deref()),
        &provider_availability,
    );

    let model = normalize_optional_string(
        profile
            .and_then(|entry| entry.model.as_deref())
            .or(config.model.as_deref())
            .or(env.get("MACHDOCH_MODEL").map(String::as_str)),
    )
    .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    let offline = match env.get("MACHDOCH_OFFLINE").map(String::as_str) {
        Some("true") => true,
        Some("false") => false,
        _ => profile
            .and_then(|entry| entry.offline)
            .or(config.offline)
            .unwrap_or(false),
    };

    Ok(RuntimeSnapshot {
        workspace_root,
        workspace_config_path,
        active_profile,
        available_profiles: get_available_profiles(&config.profiles),
        mode,
        enabled_tools,
        provider,
        model,
        offline,
        compatibility,
        provider_availability,
    })
}
