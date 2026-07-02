use std::collections::VecDeque;

use serde_json::Value;

use super::{
    commands::truncate_chars, push_bounded, string_field, RemoteControlInner, RemoteControlShared,
    RemoteLogEntry, RemoteTaskSession, RemoteTimelineEntry, MAX_COMMAND_TEXT_CHARS,
    MAX_LOG_ENTRIES, MAX_SESSIONS, MAX_TIMELINE_ENTRIES,
};

pub(super) fn record_progress_update(
    shared: &RemoteControlShared,
    task_id: &str,
    progress: &Value,
    timestamp: u64,
) {
    let normalized_task_id = task_id.trim();

    if normalized_task_id.is_empty() {
        return;
    }

    let Ok(mut inner) = shared.inner.lock() else {
        return;
    };

    let session = progress_session(&mut inner, normalized_task_id, timestamp);
    apply_progress_fields(session, progress, timestamp);
    record_action_output(session, progress, timestamp);
    record_timeline_event(session, progress, timestamp);
    notify_state_changed(shared, &mut inner);
}

fn progress_session<'a>(
    inner: &'a mut RemoteControlInner,
    task_id: &str,
    timestamp: u64,
) -> &'a mut RemoteTaskSession {
    remove_stale_session_if_needed(inner, task_id);

    inner
        .sessions
        .entry(task_id.to_string())
        .or_insert_with(|| RemoteTaskSession {
            task_id: task_id.to_string(),
            task: task_id.to_string(),
            mode: "machdoch".to_string(),
            state: "starting".to_string(),
            message: "Task started.".to_string(),
            cancellable: true,
            started_at: timestamp,
            updated_at: timestamp,
            progress_count: 0,
            logs: VecDeque::new(),
            timeline: VecDeque::new(),
        })
}

fn remove_stale_session_if_needed(inner: &mut RemoteControlInner, task_id: &str) {
    if inner.sessions.len() < MAX_SESSIONS || inner.sessions.contains_key(task_id) {
        return;
    }

    if let Some(stale_task_id) = inner
        .sessions
        .values()
        .min_by_key(|session| session.updated_at)
        .map(|session| session.task_id.clone())
    {
        inner.sessions.remove(&stale_task_id);
    }
}

fn apply_progress_fields(session: &mut RemoteTaskSession, progress: &Value, timestamp: u64) {
    session.progress_count = session.progress_count.saturating_add(1);
    session.updated_at = timestamp;

    if let Some(task) = string_field(progress, "task").filter(|value| !value.is_empty()) {
        session.task = task;
    }

    if let Some(mode) = string_field(progress, "mode").filter(|value| !value.is_empty()) {
        session.mode = mode;
    }

    if let Some(state) = string_field(progress, "state").filter(|value| !value.is_empty()) {
        session.state = state;
    }

    if let Some(message) = string_field(progress, "message") {
        session.message = message;
    }

    if let Some(cancellable) = progress.get("cancellable").and_then(Value::as_bool) {
        session.cancellable = cancellable;
    }
}

fn record_action_output(session: &mut RemoteTaskSession, progress: &Value, timestamp: u64) {
    let Some(action_output) = progress.get("actionOutput").and_then(Value::as_object) else {
        return;
    };
    let Some(chunk) = action_output.get("chunk").and_then(Value::as_str) else {
        return;
    };

    if chunk.is_empty() {
        return;
    }

    push_bounded(
        &mut session.logs,
        RemoteLogEntry {
            created_at: timestamp,
            stream: action_output
                .get("stream")
                .and_then(Value::as_str)
                .unwrap_or("stdout")
                .to_string(),
            tool_name: action_output
                .get("toolName")
                .and_then(Value::as_str)
                .map(str::to_string),
            chunk: truncate_chars(chunk, MAX_COMMAND_TEXT_CHARS),
        },
        MAX_LOG_ENTRIES,
    );
}

fn record_timeline_event(session: &mut RemoteTaskSession, progress: &Value, timestamp: u64) {
    let Some(timeline_event) = progress.get("timelineEvent").and_then(Value::as_object) else {
        return;
    };
    let (Some(kind), Some(phase), Some(label)) = (
        timeline_event.get("kind").and_then(Value::as_str),
        timeline_event.get("phase").and_then(Value::as_str),
        timeline_event.get("label").and_then(Value::as_str),
    ) else {
        return;
    };

    push_bounded(
        &mut session.timeline,
        RemoteTimelineEntry {
            created_at: timestamp,
            kind: kind.to_string(),
            phase: phase.to_string(),
            label: label.to_string(),
            detail: timeline_event
                .get("detail")
                .and_then(Value::as_str)
                .map(|value| truncate_chars(value, 1_000)),
            tone: timeline_event
                .get("tone")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_name: timeline_event
                .get("toolName")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        MAX_TIMELINE_ENTRIES,
    );
}

fn notify_state_changed(shared: &RemoteControlShared, inner: &mut RemoteControlInner) {
    inner.event_id = inner.event_id.saturating_add(1);
    shared.updates.notify_all();
}
