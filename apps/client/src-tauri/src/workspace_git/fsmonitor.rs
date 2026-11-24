use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock, PoisonError},
    time::{Duration, Instant, SystemTime},
};

use machdoch_process::SupervisedChild;

use super::{configured_command, run_optional};

const CONFIGURATION_ARGUMENTS: [&str; 4] = [
    "-c",
    "core.fsmonitor=true",
    "-c",
    "core.untrackedCache=true",
];
const DAEMON_START_TIMEOUT: Duration = Duration::from_secs(10);

static SUPPORTED: OnceLock<bool> = OnceLock::new();
static STARTED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static SETTINGS: OnceLock<Mutex<HashMap<PathBuf, (Option<SystemTime>, bool)>>> = OnceLock::new();

fn lock<T>(mutex: &'static OnceLock<Mutex<T>>) -> MutexGuard<'static, T>
where
    T: Default,
{
    mutex
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

pub(super) fn configuration_arguments() -> &'static [&'static str] {
    &CONFIGURATION_ARGUMENTS
}

fn supported() -> bool {
    *SUPPORTED.get_or_init(|| {
        run_optional("git", &["version", "--build-options"], Path::new("."))
            .is_some_and(|options| options.contains("fsmonitor--daemon"))
    })
}

fn settings_path(workspace: &Path) -> PathBuf {
    workspace.join(".machdoch").join("config.json")
}

fn read_setting(path: &Path) -> bool {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|config| {
            config
                .get("gitFileSystemMonitor")
                .and_then(|value| value.as_bool())
        })
        .unwrap_or(true)
}

pub(super) fn enabled_for(workspace: &Path) -> bool {
    if !supported() {
        return false;
    }
    let path = settings_path(workspace);
    let modified = fs::metadata(&path)
        .and_then(|metadata| metadata.modified())
        .ok();
    let mut settings = lock(&SETTINGS);
    if let Some((cached_modified, enabled)) = settings.get(workspace) {
        if *cached_modified == modified {
            return *enabled;
        }
    }
    let enabled = read_setting(&path);
    settings.insert(workspace.to_path_buf(), (modified, enabled));
    enabled
}

fn run_daemon_command(repository: &Path, action: &str) -> bool {
    let mut command = configured_command("git", &["fsmonitor--daemon", action], repository);
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let Ok(mut child) = SupervisedChild::spawn_preserving_descendants_after_exit(&mut command)
    else {
        return false;
    };
    let deadline = Instant::now() + DAEMON_START_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.terminate_and_reap();
                return false;
            }
        }
    }
}

pub(super) fn ensure_daemon(repository: &Path) {
    if !supported() || lock(&STARTED).contains(repository) {
        return;
    }
    if run_daemon_command(repository, "start") {
        lock(&STARTED).insert(repository.to_path_buf());
    }
}

pub(super) fn stop_daemons_in(workspace: &Path) {
    let repositories = lock(&STARTED)
        .iter()
        .filter(|repository| repository.starts_with(workspace))
        .cloned()
        .collect::<Vec<_>>();
    for repository in repositories {
        run_daemon_command(&repository, "stop");
        lock(&STARTED).remove(&repository);
    }
}

pub(super) fn forget_setting(workspace: &Path) {
    lock(&SETTINGS).remove(workspace);
}

#[cfg(test)]
mod tests {
    use std::{env, time::SystemTime};

    use super::*;

    #[test]
    fn reads_the_workspace_setting_and_defaults_to_enabled() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-git-fsmonitor-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(root.join(".machdoch")).expect("the workspace should be created");
        assert!(read_setting(&settings_path(&root)));
        fs::write(
            settings_path(&root),
            "{\"gitFileSystemMonitor\":false,\"autoGitignore\":true}",
        )
        .expect("the setting should write");
        assert!(!read_setting(&settings_path(&root)));
        let _ = fs::remove_dir_all(root);
    }
}
