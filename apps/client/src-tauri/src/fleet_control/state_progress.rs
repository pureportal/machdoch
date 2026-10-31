use std::collections::VecDeque;

use serde_json::Value;

use super::{
    commands::truncate_chars, push_bounded, string_field, FleetControlInner, FleetControlShared,
    FleetLogEntry, FleetTaskLiveDetail, FleetTaskSession, FleetTimelineEntry,
    MAX_COMMAND_TEXT_CHARS, MAX_FLEET_TEXT_CHARS, MAX_LOG_ENTRIES, MAX_PROGRESS_LOG_BYTES,
    MAX_SESSIONS, MAX_TIMELINE_ENTRIES,
};

const MAX_LIVE_ASSISTANT_TEXT_CHARS: usize = 8_000;
const MAX_AGENT_LIVE_BYTES: usize = 256 * 1024;

pub(super) fn task_activity_value(session: &FleetTaskSession) -> Result<Value, String> {
    let serialize_error =
        |error: serde_json::Error| format!("Failed to serialize the task activity: {error}");
    let mut activity = serde_json::to_value(session).map_err(serialize_error)?;
    activity["live"] = serde_json::to_value(&session.live).map_err(serialize_error)?;
    Ok(activity)
}

pub(super) fn record_progress_update(
    shared: &FleetControlShared,
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

    let (added_log_bytes, removed_log_bytes) = {
        let session = progress_session(&mut inner, normalized_task_id, timestamp);
        apply_progress_fields(session, progress, timestamp);
        record_live_detail(session, progress);
        let log_delta = record_action_output(session, progress, timestamp);
        record_timeline_event(session, progress, timestamp);
        log_delta
    };
    inner.progress_log_bytes = inner
        .progress_log_bytes
        .saturating_sub(removed_log_bytes)
        .saturating_add(added_log_bytes);
    trim_progress_logs_to_byte_budget(&mut inner);
    notify_state_changed(&mut inner);
}

fn progress_session<'a>(
    inner: &'a mut FleetControlInner,
    task_id: &str,
    timestamp: u64,
) -> &'a mut FleetTaskSession {
    remove_stale_session_if_needed(inner, task_id);

    inner
        .sessions
        .entry(task_id.to_string())
        .or_insert_with(|| FleetTaskSession {
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
            live: FleetTaskLiveDetail::default(),
        })
}

fn remove_stale_session_if_needed(inner: &mut FleetControlInner, task_id: &str) {
    if inner.sessions.len() < MAX_SESSIONS || inner.sessions.contains_key(task_id) {
        return;
    }

    if let Some(stale_task_id) = inner
        .sessions
        .values()
        .min_by_key(|session| session.updated_at)
        .map(|session| session.task_id.clone())
    {
        if let Some(session) = inner.sessions.remove(&stale_task_id) {
            let removed_bytes = session
                .logs
                .iter()
                .map(|entry| entry.chunk.len())
                .sum::<usize>();
            inner.progress_log_bytes = inner.progress_log_bytes.saturating_sub(removed_bytes);
        }
    }
}

fn apply_progress_fields(session: &mut FleetTaskSession, progress: &Value, timestamp: u64) {
    session.progress_count = session.progress_count.saturating_add(1);
    session.updated_at = timestamp;

    if let Some(task) = string_field(progress, "task").filter(|value| !value.is_empty()) {
        session.task = truncate_chars(&task, MAX_FLEET_TEXT_CHARS);
    }

    if let Some(mode) = string_field(progress, "mode").filter(|value| !value.is_empty()) {
        session.mode = truncate_chars(&mode, 64);
    }

    if let Some(state) = string_field(progress, "state").filter(|value| !value.is_empty()) {
        session.state = truncate_chars(&state, 64);
    }

    if let Some(message) = string_field(progress, "message") {
        session.message = truncate_chars(&message, MAX_FLEET_TEXT_CHARS);
    }

    if let Some(cancellable) = progress.get("cancellable").and_then(Value::as_bool) {
        session.cancellable = cancellable;
    }
}

fn record_live_detail(session: &mut FleetTaskSession, progress: &Value) {
    if let Some(text) = progress.get("assistantText").and_then(Value::as_str) {
        let skipped = text
            .chars()
            .count()
            .saturating_sub(MAX_LIVE_ASSISTANT_TEXT_CHARS);
        session.live.assistant_text = Some(text.chars().skip(skipped).collect());
    }
    if let Some(agent_live) = progress
        .get("agentLive")
        .filter(|agent_live| agent_live.is_object())
        .filter(|agent_live| agent_live.to_string().len() <= MAX_AGENT_LIVE_BYTES)
    {
        session.live.agent_live = Some(agent_live.clone());
    }
}

fn record_action_output(
    session: &mut FleetTaskSession,
    progress: &Value,
    timestamp: u64,
) -> (usize, usize) {
    let Some(action_output) = progress.get("actionOutput").and_then(Value::as_object) else {
        return (0, 0);
    };
    let Some(chunk) = action_output.get("chunk").and_then(Value::as_str) else {
        return (0, 0);
    };

    if chunk.is_empty() {
        return (0, 0);
    }

    let chunk = truncate_chars(chunk, MAX_COMMAND_TEXT_CHARS);
    let removed_bytes = if session.logs.len() >= MAX_LOG_ENTRIES {
        session
            .logs
            .pop_front()
            .map_or(0, |entry| entry.chunk.len())
    } else {
        0
    };
    let added_bytes = chunk.len();
    session.logs.push_back(FleetLogEntry {
        created_at: timestamp,
        stream: truncate_chars(
            action_output
                .get("stream")
                .and_then(Value::as_str)
                .unwrap_or("stdout"),
            64,
        ),
        tool_name: action_output
            .get("toolName")
            .and_then(Value::as_str)
            .map(|value| truncate_chars(value, 240)),
        chunk,
    });

    (added_bytes, removed_bytes)
}

fn trim_progress_logs_to_byte_budget(inner: &mut FleetControlInner) {
    while inner.progress_log_bytes > MAX_PROGRESS_LOG_BYTES {
        let oldest_task_id = inner
            .sessions
            .values()
            .filter_map(|session| {
                session
                    .logs
                    .front()
                    .map(|entry| (entry.created_at, session.task_id.clone()))
            })
            .min_by_key(|(created_at, _)| *created_at)
            .map(|(_, task_id)| task_id);
        let Some(oldest_task_id) = oldest_task_id else {
            inner.progress_log_bytes = 0;
            break;
        };
        let Some(session) = inner.sessions.get_mut(&oldest_task_id) else {
            continue;
        };
        let Some(entry) = session.logs.pop_front() else {
            continue;
        };

        inner.progress_log_bytes = inner.progress_log_bytes.saturating_sub(entry.chunk.len());
    }
}

fn record_timeline_event(session: &mut FleetTaskSession, progress: &Value, timestamp: u64) {
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
        FleetTimelineEntry {
            created_at: timestamp,
            kind: truncate_chars(kind, 64),
            phase: truncate_chars(phase, 64),
            label: truncate_chars(label, MAX_FLEET_TEXT_CHARS),
            detail: timeline_event
                .get("detail")
                .and_then(Value::as_str)
                .map(|value| truncate_chars(value, 1_000)),
            tone: timeline_event
                .get("tone")
                .and_then(Value::as_str)
                .map(|value| truncate_chars(value, 64)),
            tool_name: timeline_event
                .get("toolName")
                .and_then(Value::as_str)
                .map(|value| truncate_chars(value, 240)),
        },
        MAX_TIMELINE_ENTRIES,
    );
}

fn notify_state_changed(inner: &mut FleetControlInner) {
    inner.event_id = inner.event_id.saturating_add(1);
}

#[cfg(test)]
mod tests {
    use std::sync::{Condvar, Mutex};

    use serde_json::json;

    use super::*;

    fn shared() -> FleetControlShared {
        FleetControlShared {
            inner: Mutex::new(FleetControlInner::default()),
            command_completed: Condvar::new(),
        }
    }

    fn activity(shared: &FleetControlShared, task_id: &str) -> Value {
        let inner = shared.inner.lock().expect("state lock");
        task_activity_value(&inner.sessions[task_id]).expect("activity")
    }

    #[test]
    fn activity_exposes_live_detail_that_the_fleet_snapshot_omits() {
        let shared = shared();
        let long_text = format!("{}ü", "x".repeat(MAX_LIVE_ASSISTANT_TEXT_CHARS));
        record_progress_update(
            &shared,
            "task-1",
            &json!({
                "state": "executing",
                "message": "Running tests",
                "assistantText": long_text,
                "agentLive": { "provider": "claude-cli", "plan": [{ "text": "step" }] },
                "agentControl": { "url": "http://127.0.0.1:1", "token": "secret-control-token" },
                "timelineEvent": { "kind": "tool-call", "phase": "started", "label": "shell" },
                "actionOutput": { "toolName": "shell", "stream": "stdout", "chunk": "12 passed" },
            }),
            5,
        );

        let activity = activity(&shared, "task-1");
        assert_eq!(activity["state"], "executing");
        assert_eq!(activity["logs"][0]["chunk"], "12 passed");
        assert_eq!(activity["timeline"][0]["label"], "shell");
        assert_eq!(activity["live"]["agentLive"]["plan"][0]["text"], "step");
        let assistant_text = activity["live"]["assistantText"].as_str().expect("text");
        assert_eq!(
            assistant_text.chars().count(),
            MAX_LIVE_ASSISTANT_TEXT_CHARS
        );
        assert!(assistant_text.ends_with('ü'));
        assert!(!activity.to_string().contains("secret-control-token"));

        let inner = shared.inner.lock().expect("state lock");
        let wire = serde_json::to_value(&inner.sessions["task-1"]).expect("wire session");
        assert!(wire.get("live").is_none());
    }

    #[test]
    fn oversized_live_snapshots_keep_the_previous_one() {
        let shared = shared();
        record_progress_update(
            &shared,
            "task-1",
            &json!({ "agentLive": { "model": "kept" } }),
            1,
        );
        record_progress_update(
            &shared,
            "task-1",
            &json!({ "agentLive": { "model": "x".repeat(MAX_AGENT_LIVE_BYTES) } }),
            2,
        );
        assert_eq!(
            activity(&shared, "task-1")["live"]["agentLive"]["model"],
            "kept"
        );
    }
}
