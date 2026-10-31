use serde_json::{json, Map, Value};

use super::desktop_state::{
    activity_event_chars, agent_live_summary, copy_present, require_limit, MAX_ACTIVITY_PAGE_ITEMS,
    MAX_PAGE_CONTENT_CHARS,
};

pub(super) fn read_agent_activity(
    task_id: &str,
    active_task: Option<&Value>,
    activity: Option<&Value>,
    since: u64,
    limit: usize,
) -> Result<Value, String> {
    require_limit(limit, MAX_ACTIVITY_PAGE_ITEMS, "limit")?;
    if active_task.is_none() && activity.is_none() {
        return Err(format!(
            "Task `{task_id}` is not known. Only tasks from the current desktop launch are retained."
        ));
    }
    let mut result = Map::new();
    result.insert("taskId".to_string(), json!(task_id));
    result.insert("active".to_string(), json!(active_task.is_some()));
    if let Some(task) = active_task {
        copy_present(
            &mut result,
            task,
            &[
                "kind",
                "sessionId",
                "workspaceRoot",
                "arguments",
                "startedAt",
            ],
        );
    }
    let events = match activity {
        Some(activity) => {
            copy_present(
                &mut result,
                activity,
                &["task", "mode", "state", "message", "updatedAt"],
            );
            if let Some(text) = activity["live"]["assistantText"].as_str() {
                result.insert("assistantText".to_string(), json!(text));
            }
            if let Some(live) = agent_live_summary(&activity["live"]["agentLive"]) {
                result.insert("live".to_string(), live);
            }
            merged_events(activity)
        }
        None => Vec::new(),
    };
    let matching = events
        .iter()
        .filter(|event| event["timestamp"].as_u64().unwrap_or(0) >= since)
        .collect::<Vec<_>>();
    let mut used_chars = 0;
    let returned = matching
        .iter()
        .rev()
        .take(limit)
        .take_while(|event| {
            let event_chars = activity_event_chars(event);
            let fits = used_chars == 0 || used_chars + event_chars <= MAX_PAGE_CONTENT_CHARS;
            used_chars += event_chars;
            fits
        })
        .count();
    let page = &matching[matching.len() - returned..];
    result.insert(
        "omittedEvents".to_string(),
        json!(matching.len() - returned),
    );
    result.insert("events".to_string(), json!(page));
    if let Some(latest) = page.last() {
        result.insert("latestAt".to_string(), latest["timestamp"].clone());
    }
    Ok(Value::Object(result))
}

fn entries<'a>(activity: &'a Value, field: &str) -> &'a [Value] {
    activity[field].as_array().map_or(&[], Vec::as_slice)
}

fn merged_events(activity: &Value) -> Vec<Value> {
    let timeline = entries(activity, "timeline").iter().map(|entry| {
        let mut event = Map::new();
        event.insert("type".to_string(), json!("event"));
        copy_present(
            &mut event,
            entry,
            &["kind", "phase", "label", "detail", "toolName"],
        );
        event.insert("timestamp".to_string(), entry["createdAt"].clone());
        Value::Object(event)
    });
    let logs = entries(activity, "logs").iter().map(|entry| {
        let mut event = Map::new();
        event.insert("type".to_string(), json!("output"));
        copy_present(&mut event, entry, &["toolName", "stream"]);
        event.insert("text".to_string(), entry["chunk"].clone());
        event.insert("timestamp".to_string(), entry["createdAt"].clone());
        Value::Object(event)
    });
    let mut events = timeline.chain(logs).collect::<Vec<_>>();
    events.sort_by_key(|event| event["timestamp"].as_u64().unwrap_or(0));
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity() -> Value {
        json!({
            "task": "Fix the login page",
            "mode": "machdoch",
            "state": "executing",
            "message": "Running tests",
            "updatedAt": 30,
            "logs": [
                { "createdAt": 20, "stream": "stdout", "toolName": "shell", "chunk": "12 passed" }
            ],
            "timeline": [
                { "createdAt": 10, "kind": "tool-call", "phase": "started", "label": "shell", "detail": "pnpm test", "tone": "info" },
                { "createdAt": 30, "kind": "tool-call", "phase": "completed", "label": "shell" }
            ],
            "live": {
                "assistantText": "Tests pass",
                "agentLive": { "provider": "claude-cli", "transport": "stream-json", "plan": [{ "text": "step" }] }
            }
        })
    }

    fn active_task() -> Value {
        json!({ "id": "task-1", "kind": "desktop", "sessionId": "chat-a", "workspaceRoot": "C:\\Work", "arguments": [], "startedAt": 5 })
    }

    #[test]
    fn merges_timeline_and_output_for_a_running_task() {
        let result = read_agent_activity("task-1", Some(&active_task()), Some(&activity()), 0, 100)
            .expect("activity");
        assert_eq!(result["active"], true);
        assert_eq!(result["sessionId"], "chat-a");
        assert_eq!(result["state"], "executing");
        assert_eq!(result["assistantText"], "Tests pass");
        assert_eq!(result["live"]["plan"][0]["text"], "step");
        assert!(result["live"].get("transport").is_none());
        let events = result["events"].as_array().expect("events");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["detail"], "pnpm test");
        assert!(events[0].get("tone").is_none());
        assert_eq!(events[1]["type"], "output");
        assert_eq!(events[1]["text"], "12 passed");
        assert_eq!(result["latestAt"], 30);
        assert_eq!(result["omittedEvents"], 0);
    }

    #[test]
    fn since_is_inclusive_and_limit_keeps_the_newest_events() {
        let activity = activity();
        let since = read_agent_activity("task-1", None, Some(&activity), 20, 100).expect("since");
        assert_eq!(since["active"], false);
        assert_eq!(since["events"].as_array().map(Vec::len), Some(2));
        assert_eq!(since["events"][0]["text"], "12 passed");

        let tail = read_agent_activity("task-1", None, Some(&activity), 0, 1).expect("tail");
        assert_eq!(tail["events"][0]["phase"], "completed");
        assert_eq!(tail["omittedEvents"], 2);
    }

    #[test]
    fn pages_stay_within_the_character_budget() {
        let logs = (0..4)
            .map(|index| json!({ "createdAt": index, "chunk": "x".repeat(MAX_PAGE_CONTENT_CHARS / 2) }))
            .collect::<Vec<_>>();
        let activity = json!({ "logs": logs, "timeline": [] });
        let result = read_agent_activity("task-1", None, Some(&activity), 0, 100).expect("page");
        assert_eq!(result["events"].as_array().map(Vec::len), Some(2));
        assert_eq!(result["events"][1]["timestamp"], 3);
        assert_eq!(result["omittedEvents"], 2);
    }

    #[test]
    fn active_tasks_without_progress_return_an_empty_page() {
        let result =
            read_agent_activity("task-1", Some(&active_task()), None, 0, 100).expect("activity");
        assert_eq!(result["events"], json!([]));
        assert!(result.get("latestAt").is_none());
    }

    #[test]
    fn rejects_unknown_tasks_and_invalid_limits() {
        assert!(read_agent_activity("missing", None, None, 0, 100).is_err());
        let activity = activity();
        assert!(read_agent_activity("task-1", None, Some(&activity), 0, 0).is_err());
        assert!(read_agent_activity(
            "task-1",
            None,
            Some(&activity),
            0,
            MAX_ACTIVITY_PAGE_ITEMS + 1
        )
        .is_err());
    }
}
