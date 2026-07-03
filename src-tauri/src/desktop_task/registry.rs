use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex},
};

use serde::Serialize;

use super::DesktopTaskRunResponse;

const MAX_PENDING_CANCEL_IDS: usize = 256;
const MAX_RECENT_COMPLETED_TASK_RESULTS: usize = 128;

#[derive(Default)]
struct DesktopTaskCancelState {
    active: HashMap<String, ActiveDesktopTask>,
    pending: HashSet<String>,
    completed: HashMap<String, RecentDesktopTaskResult>,
    completed_order: VecDeque<String>,
}

pub struct DesktopTaskCancelMap(Mutex<DesktopTaskCancelState>);

impl Default for DesktopTaskCancelMap {
    fn default() -> Self {
        Self(Mutex::new(DesktopTaskCancelState::default()))
    }
}

struct ActiveDesktopTask {
    cancel_flag: Arc<AtomicBool>,
    kind: String,
    workspace_root: String,
    arguments: Vec<String>,
    started_at: u64,
}

pub(super) struct ActiveDesktopTaskRegistration {
    pub(super) task_id: String,
    pub(super) cancel_flag: Arc<AtomicBool>,
    pub(super) kind: String,
    pub(super) workspace_root: String,
    pub(super) arguments: Vec<String>,
    pub(super) started_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDesktopTaskSummary {
    id: String,
    kind: String,
    workspace_root: String,
    arguments: Vec<String>,
    started_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum RecentDesktopTaskOutcome {
    Succeeded { response: DesktopTaskRunResponse },
    Failed { error: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDesktopTaskResult {
    id: String,
    kind: String,
    workspace_root: String,
    arguments: Vec<String>,
    started_at: u64,
    finished_at: u64,
    outcome: RecentDesktopTaskOutcome,
}

impl RecentDesktopTaskResult {
    pub(super) fn desktop(
        id: String,
        workspace_root: String,
        arguments: Vec<String>,
        started_at: u64,
        finished_at: u64,
        result: &Result<DesktopTaskRunResponse, String>,
    ) -> Self {
        Self {
            id,
            kind: "desktop".to_string(),
            workspace_root,
            arguments,
            started_at,
            finished_at,
            outcome: match result {
                Ok(response) => RecentDesktopTaskOutcome::Succeeded {
                    response: response.clone(),
                },
                Err(error) => RecentDesktopTaskOutcome::Failed {
                    error: error.clone(),
                },
            },
        }
    }
}

fn remember_pending_cancel(cancel_state: &mut DesktopTaskCancelState, task_id: &str) {
    if task_id.trim().is_empty() || cancel_state.pending.contains(task_id) {
        return;
    }

    if cancel_state.pending.len() >= MAX_PENDING_CANCEL_IDS {
        if let Some(stale_task_id) = cancel_state.pending.iter().next().cloned() {
            cancel_state.pending.remove(&stale_task_id);
        }
    }

    cancel_state.pending.insert(task_id.to_string());
}

pub fn request_desktop_task_cancel(state: &DesktopTaskCancelMap, task_id: &str) {
    let Some(task_id) = normalize_task_id(Some(task_id)) else {
        return;
    };

    if let Ok(mut cancel_state) = state.0.lock() {
        if let Some(active_task) = cancel_state.active.get(task_id.as_str()) {
            active_task.cancel_flag.store(true, Ordering::SeqCst);
        } else {
            remember_pending_cancel(&mut cancel_state, task_id.as_str());
        }
    }
}

pub(super) fn normalize_task_id(task_id: Option<&str>) -> Option<String> {
    task_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn active_task_ids(state: &DesktopTaskCancelMap) -> Result<Vec<String>, String> {
    let cancel_state = state.0.lock().map_err(|_| {
        "Unable to inspect active desktop tasks because the task registry lock is unavailable."
            .to_string()
    })?;
    let mut task_ids = cancel_state.active.keys().cloned().collect::<Vec<_>>();

    task_ids.sort();

    Ok(task_ids)
}

pub(super) fn active_task_summaries(
    state: &DesktopTaskCancelMap,
) -> Result<Vec<ActiveDesktopTaskSummary>, String> {
    let cancel_state = state.0.lock().map_err(|_| {
        "Unable to inspect active desktop tasks because the task registry lock is unavailable."
            .to_string()
    })?;
    let mut tasks = cancel_state
        .active
        .iter()
        .map(|(id, task)| ActiveDesktopTaskSummary {
            id: id.clone(),
            kind: task.kind.clone(),
            workspace_root: task.workspace_root.clone(),
            arguments: task.arguments.clone(),
            started_at: task.started_at,
        })
        .collect::<Vec<_>>();

    tasks.sort_by(|left, right| left.id.cmp(&right.id));

    Ok(tasks)
}

pub(super) fn recent_completed_task_results(
    state: &DesktopTaskCancelMap,
    task_ids: &[String],
) -> Result<Vec<RecentDesktopTaskResult>, String> {
    let cancel_state = state.0.lock().map_err(|_| {
        "Unable to inspect completed desktop tasks because the task registry lock is unavailable."
            .to_string()
    })?;
    let mut results = Vec::new();
    let mut seen_task_ids = HashSet::new();

    for task_id in task_ids {
        let Some(task_id) = normalize_task_id(Some(task_id.as_str())) else {
            continue;
        };

        if !seen_task_ids.insert(task_id.clone()) {
            continue;
        }

        if let Some(result) = cancel_state.completed.get(&task_id) {
            results.push(result.clone());
        }
    }

    Ok(results)
}

pub(super) fn register_active_task(
    state: &DesktopTaskCancelMap,
    registration: ActiveDesktopTaskRegistration,
) {
    if let Ok(mut cancel_state) = state.0.lock() {
        if cancel_state.pending.remove(&registration.task_id) {
            registration.cancel_flag.store(true, Ordering::SeqCst);
        }

        cancel_state.active.insert(
            registration.task_id,
            ActiveDesktopTask {
                cancel_flag: registration.cancel_flag,
                kind: registration.kind,
                workspace_root: registration.workspace_root,
                arguments: registration.arguments,
                started_at: registration.started_at,
            },
        );
    }
}

pub(super) fn remember_completed_task_result(
    state: &DesktopTaskCancelMap,
    result: RecentDesktopTaskResult,
) {
    let Some(task_id) = normalize_task_id(Some(result.id.as_str())) else {
        return;
    };

    if let Ok(mut cancel_state) = state.0.lock() {
        if cancel_state.completed.contains_key(&task_id) {
            cancel_state
                .completed_order
                .retain(|existing_task_id| existing_task_id != &task_id);
        }

        cancel_state.completed_order.push_back(task_id.clone());
        cancel_state.completed.insert(task_id, result);

        while cancel_state.completed_order.len() > MAX_RECENT_COMPLETED_TASK_RESULTS {
            if let Some(stale_task_id) = cancel_state.completed_order.pop_front() {
                cancel_state.completed.remove(&stale_task_id);
            }
        }
    }
}

pub(super) fn finish_active_task(state: &DesktopTaskCancelMap, task_id: Option<&str>) {
    let Some(task_id) = normalize_task_id(task_id) else {
        return;
    };

    if let Ok(mut cancel_state) = state.0.lock() {
        cancel_state.active.remove(&task_id);
        cancel_state.pending.remove(&task_id);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        recent_completed_task_results, remember_completed_task_result, remember_pending_cancel,
        DesktopTaskCancelMap, DesktopTaskCancelState, RecentDesktopTaskOutcome,
        RecentDesktopTaskResult, MAX_PENDING_CANCEL_IDS, MAX_RECENT_COMPLETED_TASK_RESULTS,
    };
    use crate::desktop_task::DesktopTaskRunResponse;

    #[test]
    fn pending_cancel_ids_are_bounded() {
        let mut cancel_state = DesktopTaskCancelState::default();

        for index in 0..(MAX_PENDING_CANCEL_IDS + 10) {
            remember_pending_cancel(&mut cancel_state, &format!("task-{index}"));
        }

        assert_eq!(cancel_state.pending.len(), MAX_PENDING_CANCEL_IDS);
    }

    #[test]
    fn recent_completed_task_results_are_bounded_and_queryable() {
        let state = DesktopTaskCancelMap::default();

        for index in 0..(MAX_RECENT_COMPLETED_TASK_RESULTS + 2) {
            let result = Ok(DesktopTaskRunResponse {
                execution: json!({ "task": format!("task-{index}") }),
                preview: None,
            });

            remember_completed_task_result(
                &state,
                RecentDesktopTaskResult::desktop(
                    format!("task-{index}"),
                    "workspace".to_string(),
                    Vec::new(),
                    index as u64,
                    index as u64 + 1,
                    &result,
                ),
            );
        }

        let stale_results =
            recent_completed_task_results(&state, &[String::from("task-0")]).unwrap();

        assert!(stale_results.is_empty());

        let results = recent_completed_task_results(
            &state,
            &[String::from(" task-1 "), String::from("task-129")],
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "task-129");
        assert!(matches!(
            results[0].outcome,
            RecentDesktopTaskOutcome::Succeeded { .. }
        ));
    }
}
