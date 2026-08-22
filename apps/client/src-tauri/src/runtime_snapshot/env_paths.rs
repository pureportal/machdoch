use std::{
    collections::HashMap,
    env as std_env, fs,
    path::{Path, PathBuf},
};

use super::normalize_optional_string;

pub(super) fn env_path(env: &HashMap<String, String>, key: &str) -> Option<PathBuf> {
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

pub(super) fn default_agent_cli_path_candidates(
    command: &str,
    env: &HashMap<String, String>,
) -> Vec<PathBuf> {
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
                let mut versioned_binaries = Vec::new();

                if let Ok(entries) = fs::read_dir(&codex_bin) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("codex.exe");

                        if candidate.is_file() {
                            versioned_binaries.push(candidate);
                        }
                    }
                }

                versioned_binaries.sort_by(|left, right| {
                    let left_modified = left
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .ok();
                    let right_modified = right
                        .metadata()
                        .and_then(|metadata| metadata.modified())
                        .ok();

                    right_modified
                        .cmp(&left_modified)
                        .then_with(|| left.cmp(right))
                });
                candidates.extend(versioned_binaries);
                candidates.push(codex_bin.join("codex.exe"));
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

pub(super) fn is_existing_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };

    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
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

pub(super) fn command_file_names(command: &str, env: &HashMap<String, String>) -> Vec<String> {
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    #[cfg(unix)]
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    #[cfg(unix)]
    fn temp_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();

        std_env::temp_dir().join(format!("machdoch-env-paths-{name}-{unique}"))
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

    #[test]
    fn command_file_names_uses_pathext_on_windows() {
        let env = HashMap::from([("PATHEXT".to_string(), "CMD;.EXE".to_string())]);
        let names = command_file_names("codex", &env);

        if cfg!(target_os = "windows") {
            assert_eq!(
                names,
                vec![
                    "codex".to_string(),
                    "codex.CMD".to_string(),
                    "codex.EXE".to_string()
                ]
            );
        } else {
            assert_eq!(names, vec!["codex".to_string()]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn existing_file_requires_unix_executable_bit() {
        let directory = temp_test_directory("unix-executable-bit");
        let executable_path = directory.join("codex");
        let non_executable_path = directory.join("claude");

        fs::create_dir_all(&directory).expect("test directory should be creatable");
        fs::write(&executable_path, "").expect("test executable should be writable");
        fs::write(&non_executable_path, "").expect("test file should be writable");
        set_executable(&executable_path);

        assert!(is_existing_file(&executable_path));
        assert!(!is_existing_file(&non_executable_path));

        let _ = fs::remove_dir_all(directory);
    }
}
