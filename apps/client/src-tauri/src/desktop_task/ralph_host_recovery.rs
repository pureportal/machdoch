use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::Manager as _;

use super::RalphCommandRequest;

#[path = "ralph_host_recovery/manifest.rs"]
mod manifest;
#[path = "ralph_host_recovery/monitor.rs"]
mod monitor;
#[path = "ralph_host_recovery/watcher.rs"]
pub(crate) mod watcher;

pub(super) use manifest::resolve_record_path;
use manifest::{RecoveryIntent, RecoveryManifest};
use monitor::WatcherMonitor;

pub(super) struct RestoredRalphCommand {
    pub run_id: String,
    pub started_at: u64,
    pub error: Option<String>,
}

const RECOVERY_FILE_ENV: &str = "MACHDOCH_RALPH_RECOVERY_FILE";
const RECOVERY_SESSION_ENV: &str = "MACHDOCH_RALPH_RECOVERY_SESSION";

#[derive(Default)]
pub(crate) struct RalphHostRecoveryState {
    session: Mutex<Option<RecoverySession>>,
    supervision_started: AtomicBool,
}

struct RecoverySession {
    path: PathBuf,
    manifest: RecoveryManifest,
    intent_persisted: bool,
    monitor: WatcherMonitor,
}

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("ralph-recovery");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create the Ralph host recovery directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let restored_file = std::env::var_os(RECOVERY_FILE_ENV);
    let restored_session = std::env::var(RECOVERY_SESSION_ENV).ok();
    std::env::remove_var(RECOVERY_FILE_ENV);
    std::env::remove_var(RECOVERY_SESSION_ENV);
    let (session, restoring) = match (restored_file, restored_session) {
        (Some(path), Some(session_id)) => {
            let path = PathBuf::from(path);
            if path.parent().and_then(|parent| parent.canonicalize().ok())
                != Some(
                    directory
                        .canonicalize()
                        .map_err(|error| error.to_string())?,
                )
            {
                return Err("The Ralph host recovery file is outside this application's recovery directory.".to_string());
            }
            let manifest = RecoveryManifest::read(&path)?;
            if manifest.session_id != session_id || manifest.normal_shutdown {
                return Err("The Ralph host recovery session is no longer active.".to_string());
            }
            let monitor = WatcherMonitor::restore(&path, &session_id)?;
            (
                RecoverySession {
                    path,
                    manifest,
                    intent_persisted: true,
                    monitor,
                },
                true,
            )
        }
        (None, None) => {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos();
            let session_id = format!("desktop-{}-{timestamp}", std::process::id());
            (
                RecoverySession {
                    path: directory.join(format!("{session_id}.json")),
                    manifest: RecoveryManifest {
                        session_id,
                        normal_shutdown: false,
                        tasks: BTreeMap::new(),
                    },
                    intent_persisted: false,
                    monitor: WatcherMonitor::default(),
                },
                false,
            )
        }
        _ => return Err("The Ralph host recovery launch is incomplete.".to_string()),
    };
    let pending = if restoring {
        session.manifest.tasks.values().cloned().collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    *app.state::<RalphHostRecoveryState>()
        .session
        .lock()
        .map_err(|_| "The Ralph host recovery state is unavailable.".to_string())? = Some(session);
    for intent in pending {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let restored = RestoredRalphCommand {
                run_id: intent.run_id,
                started_at: intent.started_at,
                error: intent.recovery_error,
            };
            if let Err(error) = super::run_registered_ralph_command(
                app,
                intent.window_label,
                intent.request,
                Some(restored),
            )
            .await
            {
                eprintln!("Ralph desktop host recovery failed: {error}");
            }
        });
    }
    Ok(())
}

impl RalphHostRecoveryState {
    pub(super) fn start_supervision(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self
            .supervision_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        let app = app.clone();
        if let Err(error) = thread::Builder::new()
            .name("ralph-watcher-monitor".to_string())
            .spawn(move || {
                let mut last_error = None;
                loop {
                    match app.state::<RalphHostRecoveryState>().maintain_watcher() {
                        Ok(None) => return,
                        Ok(Some(true)) => last_error = None,
                        Ok(Some(false)) => {}
                        Err(error) => {
                            if last_error.as_ref() != Some(&error) {
                                eprintln!("Ralph watcher supervision failed: {error}");
                                last_error = Some(error);
                            }
                        }
                    }
                    thread::sleep(Duration::from_millis(250));
                }
            })
        {
            self.supervision_started.store(false, Ordering::SeqCst);
            return Err(format!(
                "Failed to supervise the Ralph host watcher: {error}"
            ));
        }
        Ok(())
    }

    fn maintain_watcher(&self) -> Result<Option<bool>, String> {
        let mut state = self
            .session
            .lock()
            .map_err(|_| "The Ralph host recovery state is unavailable.".to_string())?;
        let Some(session) = state.as_mut() else {
            return Ok(None);
        };
        if session.manifest.normal_shutdown {
            return Ok(None);
        }
        session
            .monitor
            .maintain(&session.path, &session.manifest)
            .map(Some)
    }

    pub(super) fn register(
        &self,
        request: &RalphCommandRequest,
        window_label: &str,
        run_id: &str,
        started_at: u64,
        restoring: bool,
        cancel_flag: &std::sync::atomic::AtomicBool,
    ) -> Result<(), String> {
        let task_id = request.task_id.as_ref().ok_or_else(|| {
            "A recoverable Ralph command requires a desktop task identifier.".to_string()
        })?;
        let mut state = self
            .session
            .lock()
            .map_err(|_| "The Ralph host recovery state is unavailable.".to_string())?;
        let session = state
            .as_mut()
            .ok_or_else(|| "Ralph host recovery is not initialized.".to_string())?;
        if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("The Ralph CLI command was cancelled.".to_string());
        }
        if session.manifest.normal_shutdown {
            return Err("Machdoch is closing. The Ralph command was not started.".to_string());
        }
        if restoring {
            let saved =
                session.manifest.tasks.get(task_id).ok_or_else(|| {
                    "Ralph host recovery was cancelled before restart.".to_string()
                })?;
            if saved.run_id != run_id {
                return Err("The Ralph host recovery task belongs to another run.".to_string());
            }
            return Ok(());
        }
        if session.manifest.tasks.is_empty() {
            session.monitor.begin_work();
        }
        let mut manifest = session.manifest.clone();
        manifest.tasks.insert(
            task_id.clone(),
            RecoveryIntent {
                request: request.clone(),
                window_label: window_label.to_string(),
                run_id: run_id.to_string(),
                record_path: resolve_record_path(request, run_id)?,
                started_at,
                failures_without_progress: 0,
                meaningful_transitions: 0,
                recovery_error: None,
            },
        );
        manifest.persist(&session.path)?;
        session.manifest = manifest;
        session.intent_persisted = true;
        if let Err(error) = session
            .monitor
            .maintain(&session.path, &session.manifest)
            .and_then(|ready| {
                if ready {
                    Ok(())
                } else {
                    Err(
                        "Automatic Ralph recovery is restarting. Try starting the run again."
                            .to_string(),
                    )
                }
            })
        {
            session.manifest.tasks.remove(task_id);
            session.manifest.persist(&session.path)?;
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn remove_task(
        &self,
        task_id: &str,
        after_removal: impl FnOnce(),
    ) -> Result<(), String> {
        let mut state = self
            .session
            .lock()
            .map_err(|_| "The Ralph host recovery state is unavailable.".to_string())?;
        if let Some(session) = state.as_mut() {
            if session.manifest.tasks.contains_key(task_id) {
                let mut manifest = session.manifest.clone();
                manifest.tasks.remove(task_id);
                manifest.persist(&session.path)?;
                session.manifest = manifest;
            }
        }
        after_removal();
        Ok(())
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let mut state = self
            .session
            .lock()
            .map_err(|_| "The Ralph host recovery state is unavailable.".to_string())?;
        let Some(session) = state.as_mut() else {
            return Ok(());
        };
        if session.manifest.normal_shutdown {
            return Ok(());
        }
        let mut manifest = session.manifest.clone();
        manifest.normal_shutdown = true;
        manifest.tasks.clear();
        if session.intent_persisted {
            manifest.persist(&session.path)?;
        }
        session.manifest = manifest;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct RecoveryFixture {
        directory: PathBuf,
        path: PathBuf,
        request: RalphCommandRequest,
        state: RalphHostRecoveryState,
    }

    impl RecoveryFixture {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!(
                "machdoch-ralph-host-tests-{}-{timestamp}",
                std::process::id()
            ));
            fs::create_dir(&directory).unwrap();
            let path = directory.join("session.json");
            let request = RalphCommandRequest {
                workspace_root: directory.to_string_lossy().into_owned(),
                arguments: vec!["run".into(), "flow".into()],
                task_id: Some("task".into()),
            };
            let intent = RecoveryIntent {
                request: request.clone(),
                window_label: "main".into(),
                run_id: "run".into(),
                record_path: directory.join("run.json"),
                started_at: 1,
                failures_without_progress: 0,
                meaningful_transitions: 0,
                recovery_error: None,
            };
            let manifest = RecoveryManifest {
                session_id: "session".into(),
                normal_shutdown: false,
                tasks: BTreeMap::from([("task".into(), intent)]),
            };
            manifest.persist(&path).unwrap();
            let state = RalphHostRecoveryState {
                session: Mutex::new(Some(RecoverySession {
                    path: path.clone(),
                    manifest,
                    intent_persisted: true,
                    monitor: WatcherMonitor::default(),
                })),
                supervision_started: AtomicBool::new(false),
            };
            Self {
                directory,
                path,
                request,
                state,
            }
        }
    }

    impl Drop for RecoveryFixture {
        fn drop(&mut self) {
            let directory = self.directory.canonicalize().unwrap();
            assert_eq!(
                directory.parent(),
                Some(std::env::temp_dir().canonicalize().unwrap().as_path())
            );
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn cancellation_is_durable_before_signalling_and_cannot_be_reinstated() {
        let fixture = RecoveryFixture::new();
        let cancelled = AtomicBool::new(false);
        fixture
            .state
            .remove_task("task", || {
                assert!(RecoveryManifest::read(&fixture.path)
                    .unwrap()
                    .tasks
                    .is_empty());
                cancelled.store(true, Ordering::SeqCst);
            })
            .unwrap();
        assert!(fixture
            .state
            .register(&fixture.request, "main", "run", 1, true, &cancelled)
            .is_err());
        assert!(RecoveryManifest::read(&fixture.path)
            .unwrap()
            .tasks
            .is_empty());
    }

    #[test]
    fn failed_cancellation_persistence_retains_intent_and_does_not_signal() {
        let fixture = RecoveryFixture::new();
        fs::rename(&fixture.path, fixture.directory.join("retained.json")).unwrap();
        fs::create_dir(&fixture.path).unwrap();
        let cancelled = AtomicBool::new(false);
        assert!(fixture
            .state
            .remove_task("task", || cancelled.store(true, Ordering::SeqCst))
            .is_err());
        assert!(!cancelled.load(Ordering::SeqCst));
        assert!(fixture
            .state
            .session
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .manifest
            .tasks
            .contains_key("task"));
    }

    #[test]
    fn shutdown_disables_restoration_and_new_work() {
        let fixture = RecoveryFixture::new();
        fixture.state.shutdown().unwrap();
        let saved = RecoveryManifest::read(&fixture.path).unwrap();
        assert!(saved.normal_shutdown);
        assert!(saved.tasks.is_empty());
        assert!(fixture
            .state
            .register(
                &fixture.request,
                "main",
                "run",
                1,
                false,
                &AtomicBool::new(false)
            )
            .is_err());
    }

    #[test]
    fn completion_removes_only_its_own_intent() {
        let fixture = RecoveryFixture::new();
        {
            let mut state = fixture.state.session.lock().unwrap();
            let session = state.as_mut().unwrap();
            session
                .manifest
                .tasks
                .insert("other".into(), session.manifest.tasks["task"].clone());
            session.manifest.persist(&session.path).unwrap();
        }
        fixture.state.remove_task("task", || {}).unwrap();
        let saved = RecoveryManifest::read(&fixture.path).unwrap();
        assert_eq!(saved.tasks.len(), 1);
        assert!(saved.tasks.contains_key("other"));
    }

    #[test]
    fn completed_checkpoint_is_reconciled_at_the_host_recovery_limit() {
        let fixture = RecoveryFixture::new();
        fs::write(fixture.directory.join("run.json"), serde_json::json!({ "id": "run", "status": "completed", "checkpoint": { "runId": "run", "progress": { "meaningfulTransitions": 0 } } }).to_string()).unwrap();
        let mut state = fixture.state.session.lock().unwrap();
        let session = state.as_mut().unwrap();
        session
            .manifest
            .tasks
            .get_mut("task")
            .unwrap()
            .failures_without_progress = 2;
        assert!(session.manifest.record_host_failure());
        assert!(session.manifest.tasks["task"].recovery_error.is_none());
        assert_eq!(session.manifest.tasks["task"].failures_without_progress, 2);
    }
}
