use std::{
    collections::HashMap,
    env as std_env,
    path::{Path, PathBuf},
};

use crate::runtime_contract_generated::AGENT_CLI_PROVIDER_ENV_KEYS;

use super::{
    env_paths::{command_file_names, default_agent_cli_path_candidates, is_existing_file},
    normalize_optional_string,
};

fn agent_cli_command_candidates(provider: &str) -> &'static [&'static str] {
    match provider {
        "codex-cli" => &["codex"],
        "claude-cli" => &["claude"],
        "copilot-cli" => &["copilot"],
        _ => &[],
    }
}

fn has_path_separator(value: &str) -> bool {
    value.contains('/') || value.contains('\\')
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

    #[cfg(unix)]
    fn set_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = fs::metadata(path)
            .expect("test file metadata should be readable")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("test file should be made executable");
    }

    fn create_executable_file(path: &Path) {
        create_file(path);

        #[cfg(unix)]
        set_executable(path);
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
    fn configured_binary_path_falls_back_to_path_resolution() {
        let directory = temp_test_directory("configured-binary-path");
        let binary_name = if cfg!(target_os = "windows") {
            "codex.CMD"
        } else {
            "codex"
        };
        let binary_path = directory.join(binary_name);
        create_executable_file(&binary_path);

        let env = HashMap::from([
            ("MACHDOCH_CODEX_CLI_PATH".to_string(), "codex".to_string()),
            ("PATH".to_string(), directory.display().to_string()),
            ("PATHEXT".to_string(), ".CMD;.EXE".to_string()),
        ]);

        assert_eq!(
            resolve_agent_cli_binary("codex-cli", &env),
            Some(binary_path)
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn copilot_cli_resolution_does_not_accept_github_cli() {
        let directory = temp_test_directory("copilot-no-gh");
        let binary_name = if cfg!(target_os = "windows") {
            "gh.cmd"
        } else {
            "gh"
        };

        create_executable_file(&directory.join(binary_name));

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

        create_executable_file(&binary_path);

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

        create_executable_file(&binary_path);

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

        create_executable_file(&packaged_binary_path);
        create_executable_file(&app_binary_path);

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

    #[cfg(unix)]
    #[test]
    fn configured_binary_path_rejects_non_executable_unix_file() {
        let directory = temp_test_directory("configured-non-executable");
        let binary_path = directory.join("codex");
        create_file(&binary_path);

        let env = HashMap::from([(
            "MACHDOCH_CODEX_CLI_PATH".to_string(),
            binary_path.display().to_string(),
        )]);

        assert!(resolve_agent_cli_binary("codex-cli", &env).is_none());

        set_executable(&binary_path);

        assert_eq!(
            resolve_agent_cli_binary("codex-cli", &env),
            Some(binary_path)
        );

        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn path_resolution_skips_non_executable_unix_file() {
        let non_executable_directory = temp_test_directory("path-non-executable");
        let executable_directory = temp_test_directory("path-executable");
        let non_executable_path = non_executable_directory.join("claude");
        let executable_path = executable_directory.join("claude");
        create_file(&non_executable_path);
        create_executable_file(&executable_path);

        let non_executable_path_value = std_env::join_paths([non_executable_directory.as_path()])
            .expect("test PATH should be joinable")
            .to_string_lossy()
            .to_string();
        let mut non_executable_env = cli_test_env(non_executable_path_value, "", None, None);
        non_executable_env.insert("MACHDOCH_CLAUDE_CLI_PATH".to_string(), "claude".to_string());

        assert!(resolve_agent_cli_binary("claude-cli", &non_executable_env).is_none());

        let path_value = std_env::join_paths([
            non_executable_directory.as_path(),
            executable_directory.as_path(),
        ])
        .expect("test PATH should be joinable")
        .to_string_lossy()
        .to_string();
        let mut env = cli_test_env(path_value, "", None, None);
        env.insert("MACHDOCH_CLAUDE_CLI_PATH".to_string(), "claude".to_string());

        assert_eq!(
            resolve_agent_cli_binary("claude-cli", &env),
            Some(executable_path)
        );

        let _ = fs::remove_dir_all(non_executable_directory);
        let _ = fs::remove_dir_all(executable_directory);
    }

    #[cfg(unix)]
    #[test]
    fn default_locations_skip_non_executable_unix_file() {
        let home_directory = temp_test_directory("default-non-executable");
        let path_directory = home_directory.join("empty-path");
        let binary_path = home_directory.join(".local").join("bin").join("copilot");
        create_file(&binary_path);
        fs::create_dir_all(&path_directory).expect("test PATH directory should be creatable");

        let env = cli_test_env(
            path_directory.display().to_string(),
            "",
            Some(&home_directory),
            None,
        );

        assert_ne!(
            resolve_agent_cli_binary("copilot-cli", &env),
            Some(binary_path.clone())
        );

        set_executable(&binary_path);

        assert_eq!(
            resolve_agent_cli_binary("copilot-cli", &env),
            Some(binary_path)
        );

        let _ = fs::remove_dir_all(home_directory);
    }
}
