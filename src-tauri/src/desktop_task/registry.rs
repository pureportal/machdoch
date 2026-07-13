use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex},
};

use serde::Serialize;

use super::DesktopTaskRunResponse;

const MAX_PENDING_CANCEL_IDS: usize = 256;
const MAX_RECENT_COMPLETED_TASK_RESULTS: usize = 128;
const MAX_RECENT_COMPLETED_TASK_RESULT_BYTES: usize = 16 * 1024 * 1024;
const MAX_CLAIMED_TASK_IDS: usize = 512;

#[derive(Default)]
struct DesktopTaskCancelState {
    active: HashMap<String, ActiveDesktopTask>,
    active_operation_owners: HashMap<String, String>,
    claimed: HashSet<String>,
    claimed_order: VecDeque<String>,
    pending: HashSet<String>,
    pending_order: VecDeque<String>,
    completed: HashMap<String, RecentDesktopTaskResult>,
    completed_order: VecDeque<String>,
    completed_sizes: HashMap<String, usize>,
    completed_bytes: usize,
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
    operation_key: Option<String>,
}

pub(super) struct ActiveDesktopTaskRegistration {
    pub(super) task_id: String,
    pub(super) cancel_flag: Arc<AtomicBool>,
    pub(super) kind: String,
    pub(super) workspace_root: String,
    pub(super) arguments: Vec<String>,
    pub(super) started_at: u64,
    pub(super) operation_key: Option<String>,
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
        if let Some(stale_task_id) = cancel_state.pending_order.pop_front() {
            cancel_state.pending.remove(&stale_task_id);
        }
    }

    cancel_state.pending.insert(task_id.to_string());
    cancel_state.pending_order.push_back(task_id.to_string());
}

fn remove_pending_cancel(cancel_state: &mut DesktopTaskCancelState, task_id: &str) -> bool {
    let removed = cancel_state.pending.remove(task_id);

    if removed {
        cancel_state
            .pending_order
            .retain(|pending_task_id| pending_task_id != task_id);
    }

    removed
}

fn trim_claimed_task_ids(cancel_state: &mut DesktopTaskCancelState) {
    let target_len = MAX_CLAIMED_TASK_IDS.max(cancel_state.active.len());
    let excess = cancel_state.claimed_order.len().saturating_sub(target_len);

    if excess == 0 {
        return;
    }

    let stale_task_ids = cancel_state
        .claimed_order
        .iter()
        .filter(|task_id| !cancel_state.active.contains_key(*task_id))
        .take(excess)
        .cloned()
        .collect::<Vec<_>>();

    for stale_task_id in stale_task_ids {
        cancel_state
            .claimed_order
            .retain(|task_id| task_id != &stale_task_id);
        cancel_state.claimed.remove(&stale_task_id);
    }
}

pub fn request_desktop_task_cancel(state: &DesktopTaskCancelMap, task_id: &str) {
    let Some(task_id) = normalize_task_id(Some(task_id)) else {
        return;
    };

    if let Ok(mut cancel_state) = state.0.lock() {
        if let Some(active_task) = cancel_state.active.get(task_id.as_str()) {
            active_task.cancel_flag.store(true, Ordering::SeqCst);
        } else if !cancel_state.claimed.contains(task_id.as_str())
            && !cancel_state.completed.contains_key(task_id.as_str())
        {
            remember_pending_cancel(&mut cancel_state, task_id.as_str());
        }
    }
}

pub fn request_all_desktop_task_cancels(state: &DesktopTaskCancelMap) -> usize {
    let Ok(cancel_state) = state.0.lock() else {
        return 0;
    };

    for task in cancel_state.active.values() {
        task.cancel_flag.store(true, Ordering::SeqCst);
    }

    cancel_state.active.len()
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

pub(super) fn acknowledge_completed_task_results(
    state: &DesktopTaskCancelMap,
    task_ids: &[String],
) -> Result<(), String> {
    let mut cancel_state = state.0.lock().map_err(|_| {
        "Unable to acknowledge completed desktop tasks because the task registry lock is unavailable."
            .to_string()
    })?;

    for task_id in task_ids {
        let Some(task_id) = normalize_task_id(Some(task_id)) else {
            continue;
        };

        cancel_state.completed.remove(&task_id);
        cancel_state
            .completed_order
            .retain(|existing_task_id| existing_task_id != &task_id);
        cancel_state.completed_bytes = cancel_state
            .completed_bytes
            .saturating_sub(cancel_state.completed_sizes.remove(&task_id).unwrap_or(0));
    }

    Ok(())
}

pub(super) fn completed_desktop_task_result(
    state: &DesktopTaskCancelMap,
    task_id: &str,
) -> Result<Option<Result<DesktopTaskRunResponse, String>>, String> {
    let Some(task_id) = normalize_task_id(Some(task_id)) else {
        return Ok(None);
    };
    let cancel_state = state.0.lock().map_err(|_| {
        "Unable to inspect the completed desktop task because the task registry lock is unavailable."
            .to_string()
    })?;

    Ok(cancel_state
        .completed
        .get(&task_id)
        .map(|result| match &result.outcome {
            RecentDesktopTaskOutcome::Succeeded { response } => Ok(response.clone()),
            RecentDesktopTaskOutcome::Failed { error } => Err(error.clone()),
        }))
}

pub(super) fn register_active_task(
    state: &DesktopTaskCancelMap,
    registration: ActiveDesktopTaskRegistration,
) -> Result<bool, String> {
    let mut cancel_state = state.0.lock().map_err(|_| {
        "Unable to claim the desktop task because the task registry lock is unavailable."
            .to_string()
    })?;

    if cancel_state.claimed.contains(&registration.task_id) {
        return Ok(false);
    }

    if let Some(operation_key) = registration.operation_key.as_deref() {
        if let Some(active_task_id) = cancel_state.active_operation_owners.get(operation_key) {
            return Err(format!(
                "MACHDOCH_OPERATION_ALREADY_ACTIVE:{active_task_id}"
            ));
        }
    }

    if remove_pending_cancel(&mut cancel_state, &registration.task_id) {
        registration.cancel_flag.store(true, Ordering::SeqCst);
    }

    cancel_state.claimed.insert(registration.task_id.clone());
    cancel_state
        .claimed_order
        .push_back(registration.task_id.clone());
    if let Some(operation_key) = registration.operation_key.as_ref() {
        cancel_state
            .active_operation_owners
            .insert(operation_key.clone(), registration.task_id.clone());
    }
    cancel_state.active.insert(
        registration.task_id,
        ActiveDesktopTask {
            cancel_flag: registration.cancel_flag,
            kind: registration.kind,
            workspace_root: registration.workspace_root,
            arguments: registration.arguments,
            started_at: registration.started_at,
            operation_key: registration.operation_key,
        },
    );

    trim_claimed_task_ids(&mut cancel_state);

    Ok(true)
}

pub(super) fn remember_completed_task_result(
    state: &DesktopTaskCancelMap,
    result: RecentDesktopTaskResult,
) {
    let Some(task_id) = normalize_task_id(Some(result.id.as_str())) else {
        return;
    };

    if let Ok(mut cancel_state) = state.0.lock() {
        let result_size = serde_json::to_vec(&result).map_or(0, |serialized| serialized.len());

        if cancel_state.completed.contains_key(&task_id) {
            cancel_state
                .completed_order
                .retain(|existing_task_id| existing_task_id != &task_id);
            cancel_state.completed_bytes = cancel_state
                .completed_bytes
                .saturating_sub(cancel_state.completed_sizes.remove(&task_id).unwrap_or(0));
        }

        cancel_state.completed_order.push_back(task_id.clone());
        cancel_state.completed_bytes = cancel_state.completed_bytes.saturating_add(result_size);
        cancel_state
            .completed_sizes
            .insert(task_id.clone(), result_size);
        cancel_state.completed.insert(task_id, result);

        while cancel_state.completed_order.len() > MAX_RECENT_COMPLETED_TASK_RESULTS
            || cancel_state.completed_bytes > MAX_RECENT_COMPLETED_TASK_RESULT_BYTES
        {
            if let Some(stale_task_id) = cancel_state.completed_order.pop_front() {
                cancel_state.completed.remove(&stale_task_id);
                cancel_state.completed_bytes = cancel_state.completed_bytes.saturating_sub(
                    cancel_state
                        .completed_sizes
                        .remove(&stale_task_id)
                        .unwrap_or(0),
                );
            }
        }
    }
}

pub(super) fn finish_active_task(state: &DesktopTaskCancelMap, task_id: Option<&str>) {
    let Some(task_id) = normalize_task_id(task_id) else {
        return;
    };

    if let Ok(mut cancel_state) = state.0.lock() {
        if let Some(active_task) = cancel_state.active.remove(&task_id) {
            if let Some(operation_key) = active_task.operation_key {
                if cancel_state
                    .active_operation_owners
                    .get(&operation_key)
                    .is_some_and(|owner_task_id| owner_task_id == &task_id)
                {
                    cancel_state.active_operation_owners.remove(&operation_key);
                }
            }
        }
        remove_pending_cancel(&mut cancel_state, &task_id);
        trim_claimed_task_ids(&mut cancel_state);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicBool, Arc};

    use serde_json::json;

    use super::{
        recent_completed_task_results, register_active_task, remember_completed_task_result,
        remember_pending_cancel, trim_claimed_task_ids, ActiveDesktopTask,
        ActiveDesktopTaskRegistration, DesktopTaskCancelMap, DesktopTaskCancelState,
        RecentDesktopTaskOutcome, RecentDesktopTaskResult, MAX_CLAIMED_TASK_IDS,
        MAX_PENDING_CANCEL_IDS, MAX_RECENT_COMPLETED_TASK_RESULTS,
        MAX_RECENT_COMPLETED_TASK_RESULT_BYTES,
    };
    use crate::desktop_task::DesktopTaskRunResponse;

    #[test]
    fn pending_cancel_ids_are_bounded() {
        let mut cancel_state = DesktopTaskCancelState::default();

        for index in 0..(MAX_PENDING_CANCEL_IDS + 10) {
            remember_pending_cancel(&mut cancel_state, &format!("task-{index}"));
        }

        assert_eq!(cancel_state.pending.len(), MAX_PENDING_CANCEL_IDS);
        assert_eq!(cancel_state.pending_order.len(), MAX_PENDING_CANCEL_IDS);
        assert!(!cancel_state.pending.contains("task-0"));
        assert!(cancel_state
            .pending
            .contains(&format!("task-{}", MAX_PENDING_CANCEL_IDS + 9)));
    }

    #[test]
    fn cancel_for_a_claimed_or_completed_task_does_not_become_pending() {
        let state = DesktopTaskCancelMap::default();
        {
            let mut cancel_state = state.0.lock().expect("state lock");
            cancel_state.claimed.insert("claimed-task".to_string());
            let completed_result = Ok(DesktopTaskRunResponse {
                execution: json!({ "ok": true }),
                preview: None,
            });
            cancel_state.completed.insert(
                "completed-task".to_string(),
                RecentDesktopTaskResult::desktop(
                    "completed-task".to_string(),
                    String::new(),
                    Vec::new(),
                    1,
                    2,
                    &completed_result,
                ),
            );
        }

        super::request_desktop_task_cancel(&state, "claimed-task");
        super::request_desktop_task_cancel(&state, "completed-task");

        let cancel_state = state.0.lock().expect("state lock");
        assert!(cancel_state.pending.is_empty());
    }

    #[test]
    fn claimed_task_ids_evict_completed_entries_behind_an_active_oldest_entry() {
        let mut cancel_state = DesktopTaskCancelState::default();
        let active_task_id = "active-oldest".to_string();
        cancel_state.claimed.insert(active_task_id.clone());
        cancel_state.claimed_order.push_back(active_task_id.clone());
        cancel_state.active.insert(
            active_task_id,
            ActiveDesktopTask {
                cancel_flag: Arc::new(AtomicBool::new(false)),
                kind: "desktop".to_string(),
                workspace_root: "workspace".to_string(),
                arguments: Vec::new(),
                started_at: 1,
                operation_key: None,
            },
        );

        for index in 0..(MAX_CLAIMED_TASK_IDS + 20) {
            let task_id = format!("completed-{index}");
            cancel_state.claimed.insert(task_id.clone());
            cancel_state.claimed_order.push_back(task_id);
        }

        trim_claimed_task_ids(&mut cancel_state);

        assert_eq!(cancel_state.claimed_order.len(), MAX_CLAIMED_TASK_IDS);
        assert!(cancel_state.claimed.contains("active-oldest"));
        assert!(!cancel_state.claimed.contains("completed-0"));
    }

    #[test]
    fn task_ids_are_claimed_only_once() {
        let state = DesktopTaskCancelMap::default();
        let registration = || ActiveDesktopTaskRegistration {
            task_id: "shared-task".to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            kind: "desktop".to_string(),
            workspace_root: "workspace".to_string(),
            arguments: Vec::new(),
            started_at: 1,
            operation_key: None,
        };

        assert_eq!(register_active_task(&state, registration()), Ok(true));
        assert_eq!(register_active_task(&state, registration()), Ok(false));
    }

    #[test]
    fn operation_key_has_exactly_one_active_owner() {
        let state = DesktopTaskCancelMap::default();
        let registration = |task_id: &str| ActiveDesktopTaskRegistration {
            task_id: task_id.to_string(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            kind: "desktop".to_string(),
            workspace_root: "workspace".to_string(),
            arguments: Vec::new(),
            started_at: 1,
            operation_key: Some("session:shared-session".to_string()),
        };

        assert_eq!(
            register_active_task(&state, registration("task-1")),
            Ok(true)
        );
        assert_eq!(
            register_active_task(&state, registration("task-2")),
            Err("MACHDOCH_OPERATION_ALREADY_ACTIVE:task-1".to_string())
        );

        super::finish_active_task(&state, Some("task-1"));
        assert_eq!(
            register_active_task(&state, registration("task-2")),
            Ok(true)
        );
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

    #[test]
    fn recent_completed_task_results_are_bounded_by_serialized_bytes() {
        let state = DesktopTaskCancelMap::default();
        let payload = "x".repeat(MAX_RECENT_COMPLETED_TASK_RESULT_BYTES / 2 + 1_024);

        for task_id in ["large-1", "large-2"] {
            let result = Ok(DesktopTaskRunResponse {
                execution: json!({ "output": payload.clone() }),
                preview: None,
            });
            remember_completed_task_result(
                &state,
                RecentDesktopTaskResult::desktop(
                    task_id.to_string(),
                    "workspace".to_string(),
                    Vec::new(),
                    1,
                    2,
                    &result,
                ),
            );
        }

        let results =
            recent_completed_task_results(&state, &["large-1".to_string(), "large-2".to_string()])
                .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "large-2");
    }
}
