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

pub(super) fn is_existing_file(path: &Path) -> bool {
    path.is_file()
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

    use super::*;

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
}
