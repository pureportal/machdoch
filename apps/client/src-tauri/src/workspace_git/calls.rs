use std::{
    cell::Cell,
    collections::VecDeque,
    path::Path,
    sync::{Mutex, MutexGuard, OnceLock, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

const MAX_RECORDED_CALLS: usize = 400;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitPriority {
    Interactive,
    Background,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCall {
    repository: String,
    arguments: Vec<String>,
    priority: GitPriority,
    started_at: u64,
    queued_ms: f64,
    duration_ms: f64,
    success: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCallLog {
    enabled: bool,
    calls: Vec<WorkspaceGitCall>,
}

thread_local! {
    static CONTEXT: Cell<(GitPriority, Duration)> =
        const { Cell::new((GitPriority::Interactive, Duration::ZERO)) };
}

static CALLS: OnceLock<Mutex<VecDeque<WorkspaceGitCall>>> = OnceLock::new();

fn calls() -> MutexGuard<'static, VecDeque<WorkspaceGitCall>> {
    CALLS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

pub(super) fn enabled() -> bool {
    cfg!(debug_assertions)
}

pub(super) fn with_context<R>(
    priority: GitPriority,
    queued: Duration,
    work: impl FnOnce() -> R,
) -> R {
    let previous = CONTEXT.with(|context| context.replace((priority, queued)));
    let result = work();
    CONTEXT.with(|context| context.set(previous));
    result
}

pub(super) fn current_priority() -> GitPriority {
    CONTEXT.with(|context| context.get().0)
}

pub(super) fn record(
    program: &str,
    arguments: &[&str],
    cwd: &Path,
    elapsed: Duration,
    success: bool,
) {
    if !enabled() {
        return;
    }
    let (priority, queued) = CONTEXT.with(|context| context.get());
    let started_at = SystemTime::now()
        .checked_sub(elapsed)
        .and_then(|started| started.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |started| started.as_millis() as u64);
    let call = WorkspaceGitCall {
        repository: cwd.display().to_string(),
        arguments: std::iter::once(program)
            .chain(arguments.iter().copied())
            .map(str::to_string)
            .collect(),
        priority,
        started_at,
        queued_ms: queued.as_secs_f64() * 1000.0,
        duration_ms: elapsed.as_secs_f64() * 1000.0,
        success,
    };
    eprintln!(
        "[workspace-git] {:>8.1} ms {:?} {} ({})",
        call.duration_ms,
        priority,
        call.arguments.join(" "),
        call.repository
    );
    let mut calls = calls();
    calls.push_back(call);
    while calls.len() > MAX_RECORDED_CALLS {
        calls.pop_front();
    }
}

pub(super) fn call_log(workspace: &Path) -> WorkspaceGitCallLog {
    WorkspaceGitCallLog {
        enabled: enabled(),
        calls: calls()
            .iter()
            .filter(|call| Path::new(&call.repository).starts_with(workspace))
            .cloned()
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_calls_with_their_priority_and_queue_time() {
        with_context(GitPriority::Background, Duration::from_millis(5), || {
            record(
                "git",
                &["status", "--porcelain=v2"],
                Path::new("workspace-under-test/repository"),
                Duration::from_millis(12),
                true,
            );
        });
        let log = call_log(Path::new("workspace-under-test"));
        assert!(log.enabled);
        let call = log
            .calls
            .iter()
            .rev()
            .find(|call| call.repository == "workspace-under-test/repository")
            .expect("the call should be recorded");
        assert_eq!(call.arguments, vec!["git", "status", "--porcelain=v2"]);
        assert_eq!(call.priority, GitPriority::Background);
        assert!((call.queued_ms - 5.0).abs() < 0.01);
        assert!((call.duration_ms - 12.0).abs() < 0.01);
        assert_eq!(current_priority(), GitPriority::Interactive);
    }
}
