use std::{
    collections::hash_map::DefaultHasher,
    env, fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

const POWERSHELL_SCRIPT: &str = include_str!("shell_integration/machdoch.ps1");
const BASH_SCRIPT: &str = include_str!("shell_integration/machdoch.bash");
const ZSHRC_SCRIPT: &str = include_str!("shell_integration/zshrc.zsh");
const ZSHENV_SCRIPT: &str = include_str!("shell_integration/zshenv.zsh");
const ZPROFILE_SCRIPT: &str = include_str!("shell_integration/zprofile.zsh");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellFlavor {
    PowerShell,
    Bash,
    Zsh,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShellLaunch {
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
}

fn flavor(kind: &str, program: &Path) -> Option<ShellFlavor> {
    let stem = program
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_ascii_lowercase);
    match (kind, stem.as_deref()) {
        ("powershell", _) | (_, Some("pwsh" | "powershell")) => Some(ShellFlavor::PowerShell),
        ("bash", _) | (_, Some("bash")) => Some(ShellFlavor::Bash),
        ("zsh", _) | (_, Some("zsh")) => Some(ShellFlavor::Zsh),
        _ => None,
    }
}

fn scripts_directory() -> PathBuf {
    let mut hasher = DefaultHasher::new();
    for script in [
        POWERSHELL_SCRIPT,
        BASH_SCRIPT,
        ZSHRC_SCRIPT,
        ZSHENV_SCRIPT,
        ZPROFILE_SCRIPT,
    ] {
        script.hash(&mut hasher);
    }
    env::temp_dir().join(format!(
        "machdoch-shell-integration-{:016x}",
        hasher.finish()
    ))
}

fn install(directory: &Path, files: &[(&str, &str)]) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    for (name, content) in files {
        let path = directory.join(name);
        if fs::read_to_string(&path).ok().as_deref() != Some(*content) {
            fs::write(&path, content).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn prepare(flavor: ShellFlavor, args: &[String], directory: &Path) -> Result<ShellLaunch, String> {
    match flavor {
        ShellFlavor::PowerShell => {
            install(directory, &[("machdoch.ps1", POWERSHELL_SCRIPT)])?;
            let script = path_text(&directory.join("machdoch.ps1")).replace('\'', "''");
            let mut launch_args = args.to_vec();
            launch_args.extend([
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!(". '{script}'"),
            ]);
            Ok(ShellLaunch {
                args: launch_args,
                env: Vec::new(),
            })
        }
        ShellFlavor::Bash => {
            install(directory, &[("machdoch.bash", BASH_SCRIPT)])?;
            let login = args
                .iter()
                .any(|argument| argument == "--login" || argument == "-l");
            let mut launch_args = args
                .iter()
                .filter(|argument| *argument != "--login" && *argument != "-l")
                .cloned()
                .collect::<Vec<_>>();
            launch_args.extend([
                "--init-file".to_string(),
                path_text(&directory.join("machdoch.bash")),
            ]);
            let mut launch_env = Vec::new();
            if login {
                launch_env.push(("MACHDOCH_LOGIN_SHELL".to_string(), "1".to_string()));
            }
            Ok(ShellLaunch {
                args: launch_args,
                env: launch_env,
            })
        }
        ShellFlavor::Zsh => {
            let zsh_directory = directory.join("zsh");
            install(
                &zsh_directory,
                &[
                    (".zshrc", ZSHRC_SCRIPT),
                    (".zshenv", ZSHENV_SCRIPT),
                    (".zprofile", ZPROFILE_SCRIPT),
                ],
            )?;
            let user_directory = env::var("ZDOTDIR")
                .ok()
                .filter(|value| !value.is_empty())
                .or_else(|| env::var("HOME").ok())
                .unwrap_or_default();
            Ok(ShellLaunch {
                args: args.to_vec(),
                env: vec![
                    ("MACHDOCH_USER_ZDOTDIR".to_string(), user_directory),
                    ("ZDOTDIR".to_string(), path_text(&zsh_directory)),
                ],
            })
        }
    }
}

pub(crate) fn shell_launch(kind: &str, program: &Path, args: &[String]) -> ShellLaunch {
    let unchanged = || ShellLaunch {
        args: args.to_vec(),
        env: Vec::new(),
    };
    let Some(flavor) = flavor(kind, program) else {
        return unchanged();
    };
    match prepare(flavor, args, &scripts_directory()) {
        Ok(launch) => launch,
        Err(error) => {
            eprintln!(
                "Shell integration is unavailable for {}: {error}",
                program.display()
            );
            unchanged()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn directory() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        env::temp_dir().join(format!(
            "machdoch-shell-integration-test-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn recognizes_shells_by_kind_or_program() {
        assert_eq!(
            flavor("powershell", Path::new("x")),
            Some(ShellFlavor::PowerShell)
        );
        assert_eq!(
            flavor("shell", Path::new("/bin/zsh")),
            Some(ShellFlavor::Zsh)
        );
        assert_eq!(
            flavor("shell", Path::new("/usr/bin/bash")),
            Some(ShellFlavor::Bash)
        );
        assert_eq!(flavor("cmd", Path::new("cmd.exe")), None);
        assert_eq!(flavor("fish", Path::new("/usr/bin/fish")), None);
    }

    #[test]
    fn launches_each_shell_with_its_integration_script() {
        let root = directory();
        let powershell = prepare(ShellFlavor::PowerShell, &["-NoLogo".to_string()], &root)
            .expect("PowerShell integration should install");
        assert_eq!(&powershell.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        assert!(powershell.args[3].ends_with("machdoch.ps1'"));
        assert!(fs::read_to_string(root.join("machdoch.ps1"))
            .expect("the script should exist")
            .contains("633;$Body"));

        let bash = prepare(ShellFlavor::Bash, &["--login".to_string()], &root)
            .expect("bash integration should install");
        assert_eq!(bash.args[0], "--init-file");
        assert_eq!(
            bash.env,
            vec![("MACHDOCH_LOGIN_SHELL".to_string(), "1".to_string())]
        );

        let zsh = prepare(ShellFlavor::Zsh, &[], &root).expect("zsh integration should install");
        assert!(zsh.args.is_empty());
        assert!(zsh
            .env
            .iter()
            .any(|(key, value)| key == "ZDOTDIR" && value.ends_with("zsh")));
        assert!(root.join("zsh").join(".zshrc").is_file());
        let _ = fs::remove_dir_all(root);
    }
}
