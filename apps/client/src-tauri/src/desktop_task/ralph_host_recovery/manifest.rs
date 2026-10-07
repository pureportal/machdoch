use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::RalphCommandRequest;
use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};

const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = 128 * 1024 * 1024;
const MAX_HOST_FAILURES_WITHOUT_PROGRESS: u32 = 3;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryIntent {
    pub request: RalphCommandRequest,
    pub window_label: String,
    pub run_id: String,
    pub record_path: PathBuf,
    pub started_at: u64,
    pub failures_without_progress: u32,
    pub meaningful_transitions: u64,
    pub recovery_error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryManifest {
    pub session_id: String,
    pub normal_shutdown: bool,
    pub tasks: BTreeMap<String, RecoveryIntent>,
}

impl RecoveryManifest {
    pub(super) fn watcher_progress(&self) -> BTreeMap<String, u64> {
        self.tasks
            .values()
            .filter_map(
                |intent| match read_saved_progress(&intent.record_path, &intent.run_id) {
                    Ok(observation) => observation
                        .meaningful_transitions
                        .map(|progress| (intent.run_id.clone(), progress)),
                    Err(error) => {
                        eprintln!(
                            "Failed to observe saved progress for Ralph watcher recovery: {error}"
                        );
                        None
                    }
                },
            )
            .collect()
    }

    pub fn read(path: &Path) -> Result<Self, String> {
        let bytes = read_bounded_file(path, MAX_MANIFEST_BYTES).map_err(|error| {
            format!(
                "Failed to read Ralph recovery manifest {}: {error}",
                path.display()
            )
        })?;
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid Ralph host recovery manifest: {error}"))
    }

    pub fn persist(&self, path: &Path) -> Result<(), String> {
        let contents = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        if contents.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("Ralph host recovery manifest exceeds its storage limit.".to_string());
        }
        write_file_atomic(path, &contents, AtomicWriteOptions::with_unix_mode(0o600))
            .map_err(|error| format!("Failed to save Ralph host recovery intent: {error}"))
    }

    pub fn record_host_failure(&mut self) -> bool {
        if self.normal_shutdown
            || self.tasks.is_empty()
            || self
                .tasks
                .values()
                .all(|intent| intent.recovery_error.is_some())
        {
            return false;
        }
        for intent in self.tasks.values_mut() {
            if intent.recovery_error.is_some() {
                continue;
            }
            let progress = match read_saved_progress(&intent.record_path, &intent.run_id) {
                Ok(observation) if observation.finished => continue,
                Ok(observation) => observation.meaningful_transitions,
                Err(error) => {
                    eprintln!("Failed to observe saved progress for Ralph host recovery: {error}");
                    None
                }
            };
            intent.record_failure(progress);
        }
        true
    }
}

impl RecoveryIntent {
    fn record_failure(&mut self, progress: Option<u64>) {
        if let Some(progress) = progress {
            if progress > self.meaningful_transitions {
                self.failures_without_progress = 0;
                self.meaningful_transitions = progress;
            }
        }
        self.failures_without_progress = self.failures_without_progress.saturating_add(1);
        if self.failures_without_progress >= MAX_HOST_FAILURES_WITHOUT_PROGRESS {
            self.recovery_error = Some(format!(
                "Ralph run {} stopped recovering after {} desktop crashes without progress. Reopen the run and inspect its saved checkpoint before resuming.",
                self.run_id, self.failures_without_progress
            ));
        }
    }
}

#[derive(Default)]
struct SavedRunObservation {
    meaningful_transitions: Option<u64>,
    finished: bool,
}

fn read_saved_progress(path: &Path, run_id: &str) -> Result<SavedRunObservation, String> {
    let bytes = match read_bounded_file(path, MAX_RECORD_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SavedRunObservation::default())
        }
        Err(error) => return Err(format!("Failed to read the saved Ralph record: {error}")),
    };
    let record: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid saved Ralph run during host recovery: {error}"))?;
    if record["id"] != run_id {
        return Err("The saved Ralph host recovery record belongs to another run.".to_string());
    }
    Ok(SavedRunObservation {
        meaningful_transitions: (record["checkpoint"]["runId"] == run_id)
            .then(|| record["checkpoint"]["progress"]["meaningfulTransitions"].as_u64())
            .flatten(),
        finished: matches!(
            record["status"].as_str(),
            Some("completed" | "stopped" | "waiting-for-input" | "blocked")
        ),
    })
}

fn read_bounded_file(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = fs::File::open(path).and_then(|file| {
            let mut bytes = Vec::new();
            file.take(limit + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > limit {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "File exceeds its storage limit",
                ));
            }
            Ok(bytes)
        });
        match result {
            Ok(bytes) => return Ok(bytes),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied
                        | std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::Interrupted
                ) && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(50))
            }
            Err(error) => return Err(error),
        }
    }
}

pub(crate) fn resolve_record_path(
    request: &RalphCommandRequest,
    run_id: &str,
) -> Result<PathBuf, String> {
    if !matches!(
        Path::new(run_id)
            .components()
            .collect::<Vec<_>>()
            .as_slice(),
        [Component::Normal(_)]
    ) {
        return Err("Expected a Ralph run identifier without path components.".to_string());
    }
    let mut scope = "workspace";
    let mut arguments = request.arguments.iter().skip(2);
    while let Some(argument) = arguments.next() {
        if argument == "--scope" {
            scope = arguments.next().map(String::as_str).unwrap_or_default();
        } else if let Some(value) = argument.strip_prefix("--scope=") {
            scope = value;
        }
    }
    let root = match scope {
        "workspace" => {
            crate::runtime_snapshot::resolve_workspace_root_path(&request.workspace_root)?
                .join(".machdoch")
                .join("local")
                .join("state")
                .join("ralph")
        }
        "user" => crate::runtime_snapshot::get_user_config_directory()?.join("ralph"),
        _ => return Err("Expected Ralph scope to be workspace or user.".to_string()),
    };
    Ok(root.join("runs").join(run_id).join("run.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent() -> RecoveryIntent {
        RecoveryIntent {
            request: RalphCommandRequest {
                workspace_root: "workspace".into(),
                arguments: vec!["run".into(), "flow".into()],
                task_id: Some("task".into()),
            },
            window_label: "main".into(),
            run_id: "run".into(),
            record_path: PathBuf::from("run.json"),
            started_at: 1,
            failures_without_progress: 0,
            meaningful_transitions: 0,
            recovery_error: None,
        }
    }

    #[test]
    fn host_recovery_budget_renews_only_after_durable_progress() {
        let mut intent = intent();
        for progress in 1..=6 {
            intent.record_failure(Some(progress));
            assert_eq!(intent.failures_without_progress, 1);
            assert!(intent.recovery_error.is_none());
        }
        intent.record_failure(Some(6));
        intent.record_failure(Some(5));
        assert_eq!(intent.meaningful_transitions, 6);
        assert!(intent.recovery_error.is_some());
    }

    #[test]
    fn missing_progress_does_not_grant_a_new_budget() {
        let mut intent = intent();
        for _ in 0..MAX_HOST_FAILURES_WITHOUT_PROGRESS {
            intent.record_failure(None);
        }
        assert!(intent.recovery_error.is_some());
    }

    #[test]
    fn normal_shutdown_and_empty_intents_do_not_restart() {
        let mut manifest = RecoveryManifest {
            session_id: "session".into(),
            normal_shutdown: false,
            tasks: BTreeMap::new(),
        };
        assert!(!manifest.record_host_failure());
        manifest.tasks.insert("task".into(), intent());
        manifest.normal_shutdown = true;
        assert!(!manifest.record_host_failure());
        assert_eq!(manifest.tasks["task"].failures_without_progress, 0);
    }
}
