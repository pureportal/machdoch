use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

const DESKTOP_TASK_PROGRESS_EVENT: &str = "desktop-task-progress";
const CLI_STRUCTURED_PROGRESS_PREFIX: &str = "machdoch-progress: ";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTaskProgressEvent {
    task_id: String,
    progress: Value,
    timestamp: u64,
}

pub(super) fn create_progress_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(super) fn parse_structured_progress_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();

    let payload = trimmed.strip_prefix(CLI_STRUCTURED_PROGRESS_PREFIX)?;

    match serde_json::from_str(payload.trim()).ok()? {
        Value::Object(progress) => Some(Value::Object(progress)),
        _ => None,
    }
}

pub(super) fn create_bridge_progress(
    task: &str,
    mode: Option<&str>,
    state: &str,
    message: &str,
    cancellable: bool,
) -> Value {
    json!({
        "task": task,
        "mode": mode.unwrap_or("machdoch"),
        "state": state,
        "message": message,
        "executedTools": [],
        "outputSections": [],
        "cancellable": cancellable,
    })
}

pub(super) fn emit_progress_event(
    app_handle: &tauri::AppHandle,
    window_label: &str,
    task_id: Option<&str>,
    progress: Value,
) {
    let Some(task_id) = task_id else {
        return;
    };
    let timestamp = create_progress_timestamp();

    crate::remote_control::record_task_progress(app_handle, task_id, &progress, timestamp);

    let _ = app_handle.emit_to(
        window_label,
        DESKTOP_TASK_PROGRESS_EVENT,
        DesktopTaskProgressEvent {
            task_id: task_id.to_string(),
            progress,
            timestamp,
        },
    );
}

pub(super) fn emit_progress_from_stderr_line(
    app_handle: &tauri::AppHandle,
    window_label: &str,
    task_id: Option<&str>,
    line: &str,
) -> bool {
    let Some(progress) = parse_structured_progress_line(line) else {
        return false;
    };

    emit_progress_event(app_handle, window_label, task_id, progress);
    true
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{create_bridge_progress, parse_structured_progress_line};

    #[test]
    fn structured_progress_lines_parse_only_object_payloads() {
        assert_eq!(
            parse_structured_progress_line(r#"machdoch-progress: {"state":"running"}"#),
            Some(json!({ "state": "running" }))
        );
        assert_eq!(
            parse_structured_progress_line("machdoch-progress: []"),
            None
        );
        assert_eq!(parse_structured_progress_line("ordinary stderr"), None);
    }

    #[test]
    fn bridge_progress_defaults_mode_to_machdoch() {
        let progress = create_bridge_progress("task", None, "cancelled", "Stopped.", false);

        assert_eq!(progress["mode"], "machdoch");
        assert_eq!(progress["cancellable"], false);
    }
}
