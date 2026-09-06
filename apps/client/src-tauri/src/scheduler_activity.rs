use std::{
    collections::HashSet,
    fs::File,
    io::{ErrorKind, Read},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::runtime_snapshot::resolve_workspace_root_path;

const MAX_SCHEDULER_STATE_BYTES: u64 = 64 * 1024 * 1024;
const SCHEDULER_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(10);
static SCHEDULER_ACTIVITY_READER: Semaphore = Semaphore::const_new(1);

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum SchedulerRunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Expired,
    Skipped,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SchedulerActivityRun {
    id: String,
    status: SchedulerRunStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerActivityState {
    schema: String,
    schema_version: u32,
    runs: Vec<SchedulerActivityRun>,
}

#[derive(Debug, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum WorkspaceSchedulerActivity {
    Loaded {
        workspace_root: String,
        runs: Vec<SchedulerActivityRun>,
    },
    Failed {
        workspace_root: String,
        error: String,
    },
}

fn read_workspace_activity(workspace_root: &str) -> Result<Vec<SchedulerActivityRun>, String> {
    let workspace_path = resolve_workspace_root_path(workspace_root)?;
    let state_path = workspace_path.join(".machdoch").join("scheduler.json");
    let file = match File::open(&state_path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Failed to read scheduler activity: {error}")),
    };
    let mut content = Vec::new();
    file.take(MAX_SCHEDULER_STATE_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|error| format!("Failed to read scheduler activity: {error}"))?;
    if content.len() as u64 > MAX_SCHEDULER_STATE_BYTES {
        return Err("Scheduler state exceeds the 64 MiB activity read limit.".to_string());
    }
    let state: SchedulerActivityState = serde_json::from_slice(&content)
        .map_err(|error| format!("Invalid scheduler activity: {error}"))?;
    if state.schema != "machdoch.smartScheduler" || state.schema_version != 2 {
        return Err("Unsupported scheduler state format.".to_string());
    }
    if state.runs.iter().any(|run| run.id.trim().is_empty()) {
        return Err("Scheduler activity contains an empty run id.".to_string());
    }
    Ok(state.runs)
}

fn read_scheduler_activity(workspace_roots: Vec<String>) -> Vec<WorkspaceSchedulerActivity> {
    let mut seen_roots = HashSet::new();
    workspace_roots
        .into_iter()
        .filter(|root| seen_roots.insert(root.clone()))
        .map(
            |workspace_root| match read_workspace_activity(&workspace_root) {
                Ok(runs) => WorkspaceSchedulerActivity::Loaded {
                    workspace_root,
                    runs,
                },
                Err(error) => WorkspaceSchedulerActivity::Failed {
                    workspace_root,
                    error,
                },
            },
        )
        .collect()
}

#[tauri::command]
pub async fn get_scheduler_activity(
    workspace_roots: Vec<String>,
) -> Result<Vec<WorkspaceSchedulerActivity>, String> {
    let permit = SCHEDULER_ACTIVITY_READER
        .try_acquire()
        .map_err(|_| "A scheduler activity read is still in progress.".to_string())?;
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        read_scheduler_activity(workspace_roots)
    });
    tokio::time::timeout(SCHEDULER_ACTIVITY_TIMEOUT, worker)
        .await
        .map_err(|_| "Scheduler activity could not be read within 10 seconds.".to_string())?
        .map_err(|error| format!("Scheduler activity reader failed: {error}"))
}

#[cfg(test)]
#[path = "scheduler_activity_tests.rs"]
mod tests;
