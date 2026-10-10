use super::has_pending_chat_work;
use serde_json::{json, Value};

fn shell(messages: Value) -> Value {
    json!({
        "sessions": [{"id": "background", "messages": messages}],
        "queuedSessionMessages": []
    })
}

fn attempted_task(status: &str, retry_number: u32) -> Value {
    shell(json!([
        {"id": "user", "taskId": "task", "role": "user", "executionAttempt": {
            "rootTaskId": "root", "task": "Work", "retryNumber": retry_number, "retryLimit": 2
        }},
        {"id": "result", "taskId": "task", "role": "agent", "outcome": {"status": status}}
    ]))
}

#[test]
fn shutdown_waits_for_dispatchable_messages_and_ignores_failed_or_orphaned_entries() {
    let mut state = shell(json!([]));
    assert!(!has_pending_chat_work(&state, true, 2).unwrap());
    for status in ["queued", "enhancing", "dispatching"] {
        state["queuedSessionMessages"] = json!([
            {"id": "failed", "sessionId": "visible", "status": "failed"},
            {"id": "pending", "sessionId": "background", "status": status}
        ]);
        assert!(has_pending_chat_work(&state, true, 2).unwrap());
    }
    state["queuedSessionMessages"] = json!([{"id": "failed", "status": "failed"}]);
    assert!(!has_pending_chat_work(&state, true, 2).unwrap());
    for status in ["queued", "enhancing", "dispatching"] {
        state["queuedSessionMessages"] =
            json!([{"id": "orphan", "sessionId": "deleted", "status": status}]);
        assert!(!has_pending_chat_work(&state, true, 2).unwrap());
    }
    state["queuedSessionMessages"] = json!([]);
    assert!(!has_pending_chat_work(&state, true, 2).unwrap());
}

#[test]
fn shutdown_waits_for_all_chat_tasks_and_transient_operations() {
    let mut state = attempted_task("succeeded", 0);
    state["sessions"].as_array_mut().unwrap().push(json!({
        "id": "another-chat", "messages": [{"id": "another-task", "role": "user"}]
    }));
    assert!(has_pending_chat_work(&state, false, 0).unwrap());
    let transient = shell(json!([{
        "id": "helper", "taskId": "helper", "role": "agent",
        "lifecycle": {"kind": "transient", "operationId": "helper"}
    }]));
    assert!(has_pending_chat_work(&transient, false, 0).unwrap());
}

#[test]
fn shutdown_waits_for_retries_without_counting_the_initial_attempt() {
    for status in ["failed", "crashed", "timed-out"] {
        for attempt in 0..2 {
            let state = attempted_task(status, attempt);
            assert!(has_pending_chat_work(&state, true, 2).unwrap());
            assert!(!has_pending_chat_work(&state, false, 2).unwrap());
            assert!(!has_pending_chat_work(&state, true, 0).unwrap());
        }
        assert!(!has_pending_chat_work(&attempted_task(status, 2), true, 2).unwrap());
    }
    for status in ["succeeded", "cancelled", "blocked", "unsupported"] {
        assert!(!has_pending_chat_work(&attempted_task(status, 0), true, 2).unwrap());
    }
}

#[test]
fn shutdown_uses_terminal_results_before_completed_thinking() {
    let mut state = attempted_task("failed", 0);
    state["sessions"][0]["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "thinking", "taskId": "task", "role": "agent",
            "source": {"kind": "thinking", "thinking": {"status": "complete"}}
        }));
    assert!(has_pending_chat_work(&state, true, 2).unwrap());
    state["sessions"][0]["messages"][1]
        .as_object_mut()
        .unwrap()
        .remove("outcome");
    state["sessions"][0]["messages"][1]["source"] = json!({
        "kind": "execution", "execution": {"status": "failed"}
    });
    assert!(has_pending_chat_work(&state, true, 2).unwrap());
    state["sessions"][0]["messages"][1]["source"] = json!({"kind": "interrupted-task"});
    assert!(has_pending_chat_work(&state, true, 2).unwrap());
}

#[test]
fn unknown_chat_state_never_authorizes_shutdown() {
    for state in [
        Value::Null,
        json!({}),
        json!({"queuedSessionMessages": []}),
        shell(Value::Null),
    ] {
        assert!(has_pending_chat_work(&state, true, 2).is_err());
    }
    assert!(has_pending_chat_work(&attempted_task("unknown", 0), true, 2).is_err());
    let mut queue = shell(json!([]));
    for value in [
        json!({}),
        json!({"status": "unknown"}),
        json!({"status": "queued"}),
    ] {
        queue["queuedSessionMessages"] = json!([value]);
        assert!(has_pending_chat_work(&queue, true, 2).is_err());
    }
}

#[test]
fn real_results_take_precedence_over_later_interruption_markers() {
    let mut state = attempted_task("succeeded", 0);
    state["sessions"][0]["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "interrupted", "taskId": "task", "role": "agent",
            "source": {"kind": "interrupted-task"}, "outcome": {"status": "crashed"}
        }));
    assert!(!has_pending_chat_work(&state, true, 2).unwrap());
}

#[test]
fn execution_results_replace_a_crashed_outcome_on_the_same_message() {
    for status in ["executed", "planned", "cancelled", "blocked", "unsupported"] {
        let mut state = attempted_task("crashed", 0);
        state["sessions"][0]["messages"][1]["source"] =
            json!({"kind": "execution", "execution": {"status": status}});
        assert!(!has_pending_chat_work(&state, true, 2).unwrap());
    }
}

#[test]
fn absent_retry_tasks_and_null_optional_fields_do_not_block_shutdown() {
    let mut state = attempted_task("failed", 0);
    state["sessions"][0]["messages"][0]["executionAttempt"]["task"] = json!("");
    assert!(!has_pending_chat_work(&state, true, 2).unwrap());
    state["sessions"][0]["messages"][0]["executionAttempt"] = Value::Null;
    assert!(!has_pending_chat_work(&state, true, 2).unwrap());
    state["sessions"][0]["messages"][1]["outcome"] = Value::Null;
    state["sessions"][0]["messages"][1]["source"] = Value::Null;
    assert!(!has_pending_chat_work(&state, true, 2).unwrap());
}

#[test]
fn previews_and_incomplete_thinking_never_finish_a_task() {
    for source in [
        json!({"kind": "preview"}),
        json!({"kind": "thinking", "thinking": {"status": "running"}}),
    ] {
        let state = shell(json!([
            {"id": "user", "taskId": "task", "role": "user"},
            {"id": "agent", "taskId": "task", "role": "agent", "source": source}
        ]));
        assert!(has_pending_chat_work(&state, false, 0).unwrap());
    }
}
