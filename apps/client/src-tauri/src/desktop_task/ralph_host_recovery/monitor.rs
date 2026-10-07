use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::{Duration, Instant},
};

use super::{
    manifest::RecoveryManifest,
    watcher::{self, WatcherProcess},
};

const MAX_WATCHER_ATTEMPTS_WITHOUT_PROGRESS: u32 = 3;
const WATCHER_RETRY_DELAY: Duration = Duration::from_secs(1);
const WATCHER_PROGRESS_POLL_DELAY: Duration = Duration::from_secs(5);

pub(super) struct WatcherMonitor {
    process: Option<WatcherProcess>,
    attempts_without_progress: u32,
    progress: BTreeMap<String, u64>,
    next_attempt: Instant,
    failure: Option<String>,
}

impl Default for WatcherMonitor {
    fn default() -> Self {
        Self {
            process: None,
            attempts_without_progress: 0,
            progress: BTreeMap::new(),
            next_attempt: Instant::now(),
            failure: None,
        }
    }
}

impl WatcherMonitor {
    pub fn restore(path: &Path, session_id: &str) -> Result<Self, String> {
        Ok(Self {
            process: Some(watcher::bind(path, session_id)?),
            ..Self::default()
        })
    }

    pub fn begin_work(&mut self) {
        self.attempts_without_progress = 0;
        self.progress.clear();
        self.next_attempt = Instant::now();
        self.failure = None;
    }

    pub fn maintain(&mut self, path: &Path, manifest: &RecoveryManifest) -> Result<bool, String> {
        self.maintain_with_launcher(path, manifest, watcher::launch)
    }

    fn maintain_with_launcher(
        &mut self,
        path: &Path,
        manifest: &RecoveryManifest,
        mut launch: impl FnMut(&Path, &str) -> Result<WatcherProcess, String>,
    ) -> Result<bool, String> {
        if let Some(process) = self.process.as_mut() {
            if process.is_alive()? {
                self.failure = None;
                return Ok(true);
            }
            self.process = None;
        }
        if manifest.normal_shutdown || manifest.tasks.is_empty() {
            return Ok(false);
        }
        if Instant::now() < self.next_attempt {
            return Ok(false);
        }
        let active_runs: BTreeSet<_> = manifest
            .tasks
            .values()
            .map(|intent| intent.run_id.as_str())
            .collect();
        self.progress
            .retain(|run_id, _| active_runs.contains(run_id.as_str()));
        let mut advanced = false;
        for (run_id, progress) in manifest.watcher_progress() {
            let recorded = self.progress.entry(run_id).or_default();
            if progress > *recorded {
                *recorded = progress;
                advanced = true;
            }
        }
        if advanced {
            self.attempts_without_progress = 0;
            self.failure = None;
        }
        if self.attempts_without_progress >= MAX_WATCHER_ATTEMPTS_WITHOUT_PROGRESS {
            self.next_attempt = Instant::now() + WATCHER_PROGRESS_POLL_DELAY;
            let reason = self
                .failure
                .as_deref()
                .unwrap_or("The watcher repeatedly exited.");
            return Err(format!(
                "Automatic Ralph recovery is unavailable after {MAX_WATCHER_ATTEMPTS_WITHOUT_PROGRESS} watcher starts without saved progress. {reason} Inspect the run and restart Machdoch before starting more work."
            ));
        }
        self.attempts_without_progress += 1;
        self.next_attempt = Instant::now() + WATCHER_RETRY_DELAY;
        match launch(path, &manifest.session_id) {
            Ok(process) => {
                self.process = Some(process);
                self.failure = None;
                Ok(true)
            }
            Err(error) => {
                self.failure = Some(error.clone());
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::{Command, Stdio},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::super::{super::RalphCommandRequest, manifest::RecoveryIntent};
    use crate::child_process::configure_child_process_group;

    struct MonitorFixture {
        directory: PathBuf,
        manifest: RecoveryManifest,
        monitor: WatcherMonitor,
        launches: u32,
    }

    impl MonitorFixture {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!(
                "machdoch-ralph-monitor-tests-{}-{timestamp}",
                std::process::id()
            ));
            fs::create_dir(&directory).unwrap();
            let intent = RecoveryIntent {
                request: RalphCommandRequest {
                    workspace_root: directory.to_string_lossy().into_owned(),
                    arguments: vec!["run".into(), "flow".into()],
                    task_id: Some("task".into()),
                },
                window_label: "main".into(),
                run_id: "run".into(),
                record_path: directory.join("run.json"),
                started_at: 1,
                failures_without_progress: 0,
                meaningful_transitions: 0,
                recovery_error: None,
            };
            Self {
                directory,
                manifest: RecoveryManifest {
                    session_id: "session".into(),
                    normal_shutdown: false,
                    tasks: BTreeMap::from([("task".into(), intent)]),
                },
                monitor: WatcherMonitor::default(),
                launches: 0,
            }
        }

        fn poll(&mut self) -> Result<bool, String> {
            self.monitor.next_attempt = Instant::now();
            self.monitor.maintain_with_launcher(
                &self.directory.join("session.json"),
                &self.manifest,
                |_, _| {
                    self.launches += 1;
                    let mut command = Command::new(std::env::var("RALPH_VERIFIER_NODE").unwrap());
                    command.args(["-e", "setInterval(()=>{},1000)"]);
                    configure_child_process_group(&mut command);
                    command
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    command
                        .spawn()
                        .map(WatcherProcess::Child)
                        .map_err(|error| error.to_string())
                },
            )
        }

        fn interrupt(&mut self) {
            if let Some(WatcherProcess::Child(child)) = self.monitor.process.as_mut() {
                child.kill().unwrap();
                child.wait().unwrap();
            }
        }

        fn progress(&self, progress: u64) {
            fs::write(self.directory.join("run.json"), serde_json::json!({ "id": "run", "status": "running", "checkpoint": { "runId": "run", "progress": { "meaningfulTransitions": progress } } }).to_string()).unwrap();
        }
    }

    impl Drop for MonitorFixture {
        fn drop(&mut self) {
            if let Some(WatcherProcess::Child(child)) = self.monitor.process.as_mut() {
                if child.try_wait().unwrap().is_none() {
                    child.kill().unwrap();
                    child.wait().unwrap();
                }
            }
            let directory = self.directory.canonicalize().unwrap();
            assert_eq!(
                directory.parent(),
                Some(std::env::temp_dir().canonicalize().unwrap().as_path())
            );
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn live_watcher_is_reused_and_exited_child_is_replaced() {
        let mut fixture = MonitorFixture::new();
        assert!(fixture.poll().unwrap());
        assert!(fixture.poll().unwrap());
        assert_eq!(fixture.launches, 1);
        fixture.interrupt();
        assert!(fixture.poll().unwrap());
        assert_eq!(fixture.launches, 2);
    }

    #[test]
    fn repeated_watcher_exits_are_bounded_without_saved_progress() {
        let mut fixture = MonitorFixture::new();
        for _ in 0..MAX_WATCHER_ATTEMPTS_WITHOUT_PROGRESS {
            assert!(fixture.poll().unwrap());
            fixture.interrupt();
        }
        assert!(fixture.poll().is_err());
        assert!(fixture.poll().is_err());
        assert_eq!(fixture.launches, MAX_WATCHER_ATTEMPTS_WITHOUT_PROGRESS);
        assert_eq!(fixture.manifest.tasks.len(), 1);
    }

    #[test]
    fn durable_progress_renews_watcher_recovery_after_exhaustion() {
        let mut fixture = MonitorFixture::new();
        for progress in 1..=6 {
            fixture.progress(progress);
            assert!(fixture.poll().unwrap());
            fixture.interrupt();
        }
        assert!(fixture.poll().unwrap());
        fixture.interrupt();
        assert!(fixture.poll().unwrap());
        fixture.interrupt();
        assert!(fixture.poll().is_err());
        fixture.progress(7);
        assert!(fixture.poll().unwrap());
        assert!(fixture.launches > MAX_WATCHER_ATTEMPTS_WITHOUT_PROGRESS);
    }

    #[test]
    fn missing_or_regressed_progress_does_not_reset_watcher_budget() {
        let mut fixture = MonitorFixture::new();
        fixture.progress(5);
        assert!(fixture.poll().unwrap());
        fixture.interrupt();
        fs::remove_file(fixture.directory.join("run.json")).unwrap();
        assert!(fixture.poll().unwrap());
        fixture.interrupt();
        fixture.progress(4);
        assert!(fixture.poll().unwrap());
        fixture.interrupt();
        assert!(fixture.poll().is_err());
        fixture.progress(5);
        assert!(fixture.poll().is_err());
        assert_eq!(fixture.launches, 3);
    }

    #[test]
    fn empty_or_closed_sessions_do_not_launch_watchers() {
        let mut fixture = MonitorFixture::new();
        fixture.manifest.normal_shutdown = true;
        assert!(!fixture.poll().unwrap());
        fixture.manifest.normal_shutdown = false;
        fixture.manifest.tasks.clear();
        assert!(!fixture.poll().unwrap());
        assert_eq!(fixture.launches, 0);
    }

    #[test]
    fn failed_starts_preserve_intent_and_obey_backoff_and_budget() {
        let mut fixture = MonitorFixture::new();
        let mut launches = 0;
        for _ in 0..MAX_WATCHER_ATTEMPTS_WITHOUT_PROGRESS {
            fixture.monitor.next_attempt = Instant::now();
            assert!(fixture
                .monitor
                .maintain_with_launcher(&fixture.directory, &fixture.manifest, |_, _| {
                    launches += 1;
                    Err("fixture spawn failure".to_string())
                })
                .is_err());
            assert!(!fixture
                .monitor
                .maintain_with_launcher(&fixture.directory, &fixture.manifest, |_, _| panic!(
                    "Backoff must prevent another start"
                ))
                .unwrap());
        }
        fixture.monitor.next_attempt = Instant::now();
        assert!(fixture
            .monitor
            .maintain_with_launcher(&fixture.directory, &fixture.manifest, |_, _| panic!(
                "The exhausted budget must prevent another start"
            ))
            .unwrap_err()
            .contains("fixture spawn failure"));
        assert_eq!(launches, 3);
        assert_eq!(fixture.manifest.tasks.len(), 1);
    }
}
