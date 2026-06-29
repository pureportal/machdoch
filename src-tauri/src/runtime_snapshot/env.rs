use std::{
    collections::HashMap,
    env as std_env, fs,
    path::{Path, PathBuf},
};

use crate::runtime_contract_generated::{
    AGENT_CLI_PROVIDER_ENV_KEYS, PROVIDER_ENV_KEYS, RUNTIME_ENV_KEYS, WEB_SEARCH_ENV_KEYS,
};

use super::{
    merge_user_agent_cli_paths_into_env, merge_user_api_keys_into_env,
    merge_user_web_search_api_keys_into_env, normalize_optional_string, strip_wrapping_quotes,
};

const PLACEHOLDER_TOKENS: [&str; 3] = ["YOUR_", "CHANGE_ME", "PLACEHOLDER"];
const KNOWN_SAMPLE_SECRET_VALUES: [&str; 6] = [
    "sk-user-config",
    "sk-live",
    "pplx-live",
    "tvly-live",
    "tavily-live",
    "serper-live",
];

fn parse_dotenv_file(path: &Path) -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some(separator_index) = trimmed.find('=') else {
            continue;
        };

        let key = trimmed[..separator_index].trim();
        let value = strip_wrapping_quotes(&trimmed[separator_index + 1..]);

        values.insert(key.to_string(), value);
    }

    Ok(values)
}

fn apply_process_env_overrides(values: &mut HashMap<String, String>) {
    for key in PROVIDER_ENV_KEYS
        .iter()
        .map(|(_, key)| *key)
        .chain(WEB_SEARCH_ENV_KEYS.iter().map(|(_, key)| *key))
        .chain(RUNTIME_ENV_KEYS.iter().copied())
    {
        if let Ok(value) = std_env::var(key) {
            values.insert(key.to_string(), value);
        }
    }
}

pub(crate) fn load_global_env() -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    merge_user_api_keys_into_env(&mut values)?;
    merge_user_agent_cli_paths_into_env(&mut values)?;
    merge_user_web_search_api_keys_into_env(&mut values)?;
    apply_process_env_overrides(&mut values);
    Ok(values)
}

pub(super) fn load_workspace_env(workspace_root: &Path) -> Result<HashMap<String, String>, String> {
    let env_path = workspace_root.join(".env");
    let mut values = HashMap::new();

    merge_user_api_keys_into_env(&mut values)?;
    merge_user_agent_cli_paths_into_env(&mut values)?;
    merge_user_web_search_api_keys_into_env(&mut values)?;

    if env_path.exists() {
        for (key, value) in parse_dotenv_file(&env_path)? {
            values.insert(key, value);
        }
    }

    apply_process_env_overrides(&mut values);

    Ok(values)
}

pub(super) fn has_configured_value(value: Option<&str>) -> bool {
    let Some(value) = value.map(str::trim) else {
        return false;
    };

    if value.is_empty() {
        return false;
    }

    if KNOWN_SAMPLE_SECRET_VALUES.contains(&value) {
        return false;
    }

    !PLACEHOLDER_TOKENS.iter().any(|token| value.contains(token))
}

fn agent_cli_command_candidates(provider: &str) -> &'static [&'static str] {
    match provider {
        "codex-cli" => &["codex"],
        "claude-cli" => &["claude"],
        "copilot-cli" => &["copilot"],
        _ => &[],
    }
}

fn env_path(env: &HashMap<String, String>, key: &str) -> Option<PathBuf> {
    env.get(key)
        .and_then(|value| normalize_optional_string(Some(value.as_str())))
        .map(PathBuf::from)
        .or_else(|| std_env::var_os(key).map(PathBuf::from))
}

fn home_directory_from_env(env: &HashMap<String, String>) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env_path(env, "USERPROFILE").or_else(|| env_path(env, "HOME"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        env_path(env, "HOME")
    }
}

fn default_agent_cli_path_candidates(command: &str, env: &HashMap<String, String>) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let user_profile = home_directory_from_env(env);
        let app_data = env_path(env, "APPDATA").or_else(|| {
            user_profile
                .as_ref()
                .map(|path| path.join("AppData").join("Roaming"))
        });
        let local_app_data = env_path(env, "LOCALAPPDATA").or_else(|| {
            user_profile
                .as_ref()
                .map(|path| path.join("AppData").join("Local"))
        });
        let mut candidates = Vec::new();

        if let Some(user_profile) = user_profile {
            candidates.push(
                user_profile
                    .join(".local")
                    .join("bin")
                    .join(format!("{command}.exe")),
            );
        }

        if let Some(app_data) = app_data {
            candidates.push(app_data.join("npm").join(format!("{command}.cmd")));
            candidates.push(app_data.join("npm").join(format!("{command}.exe")));
        }

        if let Some(local_app_data) = local_app_data {
            candidates.push(
                local_app_data
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Links")
                    .join(format!("{command}.exe")),
            );
            candidates.push(
                local_app_data
                    .join("Microsoft")
                    .join("WindowsApps")
                    .join(format!("{command}.exe")),
            );

            if command == "codex" {
                let codex_bin = local_app_data.join("OpenAI").join("Codex").join("bin");
                candidates.push(codex_bin.join("codex.exe"));

                if let Ok(entries) = fs::read_dir(&codex_bin) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("codex.exe");

                        if candidate.is_file() {
                            candidates.push(candidate);
                        }
                    }
                }
            }
        }

        candidates
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut candidates = Vec::new();

        if let Some(home_directory) = home_directory_from_env(env) {
            candidates.push(home_directory.join(".local").join("bin").join(command));
        }

        candidates.push(PathBuf::from("/usr/local/bin").join(command));
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(command));
        candidates.push(PathBuf::from("/usr/bin").join(command));
        candidates
    }
}

fn has_path_separator(value: &str) -> bool {
    value.contains('/') || value.contains('\\')
}

fn is_existing_file(path: &Path) -> bool {
    path.is_file()
}

fn is_windows_packaged_app_path(path: &Path) -> bool {
    cfg!(target_os = "windows")
        && path
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("\\program files\\windowsapps\\")
}

fn is_resolvable_command_file(path: &Path) -> bool {
    is_existing_file(path) && !is_windows_packaged_app_path(path)
}

fn executable_extensions(env: &HashMap<String, String>) -> Vec<String> {
    if cfg!(target_os = "windows") {
        env.get("PATHEXT")
            .cloned()
            .or_else(|| std_env::var("PATHEXT").ok())
            .map(|value| {
                value
                    .split(';')
                    .filter_map(|entry| normalize_optional_string(Some(entry)))
                    .map(|extension| {
                        if extension.starts_with('.') {
                            extension
                        } else {
                            format!(".{extension}")
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|extensions| !extensions.is_empty())
            .unwrap_or_else(|| {
                vec![
                    ".COM".to_string(),
                    ".EXE".to_string(),
                    ".BAT".to_string(),
                    ".CMD".to_string(),
                ]
            })
    } else {
        Vec::new()
    }
}

fn command_file_names(command: &str, env: &HashMap<String, String>) -> Vec<String> {
    if !cfg!(target_os = "windows") || Path::new(command).extension().is_some() {
        return vec![command.to_string()];
    }

    let mut names = vec![command.to_string()];
    names.extend(
        executable_extensions(env)
            .into_iter()
            .map(|extension| format!("{command}{extension}")),
    );
    names
}

fn resolve_command_on_path(command: &str, env: &HashMap<String, String>) -> Option<PathBuf> {
    let path_value = env
        .get("PATH")
        .map(std::ffi::OsString::from)
        .or_else(|| std_env::var_os("PATH"))?;
    let command_file_names = command_file_names(command, env);

    for directory in std_env::split_paths(&path_value) {
        for file_name in &command_file_names {
            let candidate = directory.join(file_name);

            if is_resolvable_command_file(&candidate) {
                return Some(candidate);
            }
        }
    }

    None
}

fn resolve_configured_binary_path(
    configured_path: &str,
    env: &HashMap<String, String>,
) -> Option<PathBuf> {
    let candidate = PathBuf::from(configured_path);

    if is_existing_file(&candidate) {
        return Some(candidate);
    }

    if !has_path_separator(configured_path) {
        return resolve_command_on_path(configured_path, env);
    }

    let parent = candidate.parent()?;
    let file_name = candidate.file_name()?.to_str()?;

    for candidate_file_name in command_file_names(file_name, env) {
        let candidate = parent.join(candidate_file_name);

        if is_existing_file(&candidate) {
            return Some(candidate);
        }
    }

    None
}

pub(super) fn resolve_agent_cli_binary(
    provider: &str,
    env: &HashMap<String, String>,
) -> Option<PathBuf> {
    if let Some((_, env_key)) = AGENT_CLI_PROVIDER_ENV_KEYS
        .iter()
        .find(|(entry_provider, _)| *entry_provider == provider)
    {
        if let Some(configured_path) = env
            .get(*env_key)
            .and_then(|value| normalize_optional_string(Some(value.as_str())))
        {
            return resolve_configured_binary_path(&configured_path, env);
        }
    }

    for command in agent_cli_command_candidates(provider) {
        let resolved = if has_path_separator(command) {
            resolve_configured_binary_path(command, env)
        } else {
            resolve_command_on_path(command, env)
        };

        if resolved.is_some() {
            return resolved;
        }
    }

    for command in agent_cli_command_candidates(provider) {
        for candidate in default_agent_cli_path_candidates(command, env) {
            if let Some(candidate_path) = candidate.to_str() {
                let resolved = resolve_configured_binary_path(candidate_path, env);

                if resolved.is_some() {
                    return resolved;
                }
            }
        }
    }

    None
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

        std_env::temp_dir().join(format!("machdoch-{name}-{unique}"))
    }

    fn create_file(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("test directory should be creatable");
        }

        fs::write(path, "").expect("test binary should be writable");
    }

    fn cli_test_env(
        path: String,
        pathext: &str,
        home_directory: Option<&Path>,
        local_app_data: Option<&Path>,
    ) -> HashMap<String, String> {
        let mut env = HashMap::from([
            ("PATH".to_string(), path),
            ("PATHEXT".to_string(), pathext.to_string()),
        ]);

        if let Some(home_directory) = home_directory {
            if cfg!(target_os = "windows") {
                env.insert(
                    "USERPROFILE".to_string(),
                    home_directory.display().to_string(),
                );
                env.insert(
                    "APPDATA".to_string(),
                    home_directory
                        .join("AppData")
                        .join("Roaming")
                        .display()
                        .to_string(),
                );
            } else {
                env.insert("HOME".to_string(), home_directory.display().to_string());
            }
        }

        if let Some(local_app_data) = local_app_data {
            env.insert(
                "LOCALAPPDATA".to_string(),
                local_app_data.display().to_string(),
            );
        }

        env
    }

    #[test]
    fn dotenv_parser_trims_keys_values_and_ignores_comments() {
        let directory = temp_test_directory("dotenv");
        let env_path = directory.join(".env");
        fs::create_dir_all(&directory).expect("test directory should be creatable");
        fs::write(
            &env_path,
            "\n# comment\nOPENAI_API_KEY = \"sk-test\"\nMACHDOCH_DEFAULT_MODE=machdoch\n",
        )
        .expect("dotenv should be writable");

        let values = parse_dotenv_file(&env_path).expect("dotenv should parse");

        assert_eq!(values.get("OPENAI_API_KEY"), Some(&"sk-test".to_string()));
        assert_eq!(
            values.get("MACHDOCH_DEFAULT_MODE"),
            Some(&"machdoch".to_string())
        );
        assert!(!values.contains_key("# comment"));

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn configured_value_rejects_placeholders_samples_and_blanks() {
        assert!(!has_configured_value(Some("")));
        assert!(!has_configured_value(Some("YOUR_API_KEY")));
        assert!(!has_configured_value(Some("sk-live")));
        assert!(has_configured_value(Some("sk-real-value")));
    }

    #[test]
    fn copilot_cli_resolution_does_not_accept_github_cli() {
        let directory = temp_test_directory("copilot-no-gh");
        let binary_name = if cfg!(target_os = "windows") {
            "gh.cmd"
        } else {
            "gh"
        };

        create_file(&directory.join(binary_name));

        let env = cli_test_env(directory.display().to_string(), ".CMD;.EXE", None, None);

        assert!(resolve_agent_cli_binary("copilot-cli", &env).is_none());

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn copilot_cli_resolution_checks_common_default_install_locations() {
        let home_directory = temp_test_directory("copilot-default-path");
        let binary_path = if cfg!(target_os = "windows") {
            home_directory
                .join("AppData")
                .join("Roaming")
                .join("npm")
                .join("copilot.cmd")
        } else {
            home_directory.join(".local").join("bin").join("copilot")
        };

        create_file(&binary_path);

        let env = cli_test_env(
            String::new(),
            ".CMD;.EXE",
            Some(&home_directory),
            Some(&home_directory.join("AppData").join("Local")),
        );

        assert_eq!(
            resolve_agent_cli_binary("copilot-cli", &env),
            Some(binary_path)
        );

        let _ = fs::remove_dir_all(home_directory);
    }

    #[test]
    fn codex_cli_resolution_checks_windows_app_install_locations() {
        if !cfg!(target_os = "windows") {
            return;
        }

        let home_directory = temp_test_directory("codex-windows-app-path");
        let local_app_data = home_directory.join("AppData").join("Local");
        let binary_path = local_app_data
            .join("OpenAI")
            .join("Codex")
            .join("bin")
            .join("codex.exe");

        create_file(&binary_path);

        let env = cli_test_env(
            String::new(),
            ".CMD;.EXE",
            Some(&home_directory),
            Some(&local_app_data),
        );

        assert_eq!(
            resolve_agent_cli_binary("codex-cli", &env),
            Some(binary_path)
        );

        let _ = fs::remove_dir_all(home_directory);
    }

    #[test]
    fn codex_cli_resolution_skips_packaged_app_path_aliases() {
        if !cfg!(target_os = "windows") {
            return;
        }

        let home_directory = temp_test_directory("codex-windows-packaged-app");
        let local_app_data = home_directory.join("AppData").join("Local");
        let packaged_directory = home_directory
            .join("Program Files")
            .join("WindowsApps")
            .join("OpenAI.Codex_1.0.0.0_x64__test")
            .join("app")
            .join("resources");
        let packaged_binary_path = packaged_directory.join("codex.exe");
        let app_binary_path = local_app_data
            .join("OpenAI")
            .join("Codex")
            .join("bin")
            .join("current")
            .join("codex.exe");

        create_file(&packaged_binary_path);
        create_file(&app_binary_path);

        let env = cli_test_env(
            packaged_directory.display().to_string(),
            ".EXE",
            Some(&home_directory),
            Some(&local_app_data),
        );

        assert_eq!(
            resolve_agent_cli_binary("codex-cli", &env),
            Some(app_binary_path)
        );

        let _ = fs::remove_dir_all(home_directory);
    }
}
