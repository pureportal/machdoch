use std::fs;

use axum::http::{HeaderMap, HeaderValue};
use serde_json::json;

use super::{
    auth::{
        constant_time_eq, hash_remote_control_token, headers_are_authorized,
        state_changing_headers_allowed,
    },
    mission_control_html::mission_control_html,
    now_millis,
    state::RecordCommandOutcome,
    status::{create_snapshot_locked, create_status_locked, create_token_hint},
    test_support::{temp_test_directory, use_user_config_dir},
    RemoteControlCommandEvent, RemoteControlInner, RemoteControlPairedDevice, RemoteControlState,
    DEFAULT_REMOTE_CONTROL_PORT, WEB_SESSION_COOKIE_NAME, WEB_SESSION_TTL_MS,
};

fn cancel_command(command_id: &str, task_id: &str, created_at: u64) -> RemoteControlCommandEvent {
    RemoteControlCommandEvent {
        command_id: command_id.to_string(),
        kind: "cancel".to_string(),
        task_id: Some(task_id.to_string()),
        session_id: None,
        prompt: None,
        title: None,
        tags: None,
        provider: None,
        model: None,
        mode: None,
        reasoning: None,
        workspace: None,
        enabled: None,
        attachment_id: None,
        context_pack_id: None,
        message_id: None,
        job_id: None,
        run_id: None,
        created_at,
    }
}

#[test]
fn token_comparison_requires_same_bytes_and_length() {
    assert!(constant_time_eq(b"abc123", b"abc123"));
    assert!(!constant_time_eq(b"abc123", b"abc124"));
    assert!(!constant_time_eq(b"abc123", b"abc1234"));
}

#[test]
fn api_authorization_requires_paired_session_cookie() {
    let state = RemoteControlState::default();
    let session_token = "browser-session-token";
    {
        let mut inner = state.shared.inner.lock().expect("state lock");
        inner.config_loaded = true;
        inner.config.paired_devices.push(RemoteControlPairedDevice {
            id: "device-1".to_string(),
            name: "Test browser".to_string(),
            token_hash: hash_remote_control_token(session_token),
            created_at: 1,
            last_seen_at: 1,
            expires_at: now_millis().saturating_add(WEB_SESSION_TTL_MS),
            user_agent: None,
        });
    }
    let mut bearer_headers = HeaderMap::new();
    bearer_headers.insert(
        "authorization",
        HeaderValue::from_static("Bearer control-token"),
    );
    let mut cookie_headers = HeaderMap::new();
    cookie_headers.insert(
        "cookie",
        HeaderValue::from_str(&format!("{WEB_SESSION_COOKIE_NAME}={session_token}"))
            .expect("cookie header"),
    );
    let query_headers = HeaderMap::new();

    assert!(!headers_are_authorized(&bearer_headers, &state.shared));
    assert!(headers_are_authorized(&cookie_headers, &state.shared));
    assert!(!headers_are_authorized(&query_headers, &state.shared));
}

#[test]
fn state_changing_requests_require_custom_remote_header() {
    let missing_header = HeaderMap::new();
    let mut same_origin = HeaderMap::new();
    same_origin.insert("x-machdoch-remote", HeaderValue::from_static("1"));
    same_origin.insert("origin", HeaderValue::from_static("http://127.0.0.1:5000"));
    same_origin.insert("host", HeaderValue::from_static("127.0.0.1:5000"));

    assert!(!state_changing_headers_allowed(&missing_header));
    assert!(state_changing_headers_allowed(&same_origin));
}

#[test]
fn state_status_loads_default_config_when_file_is_missing() {
    let directory = temp_test_directory("default-config");
    let _env = use_user_config_dir(&directory);
    let state = RemoteControlState::default();

    let status = state.status().expect("status should load default config");

    assert!(!status.enabled);
    assert_eq!(status.port, DEFAULT_REMOTE_CONTROL_PORT);
    assert_eq!(status.paired_device_count, 0);
    assert!(state.shared.inner.lock().expect("state lock").config_loaded);

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn state_status_loads_stored_pairings_from_config_file() {
    let directory = temp_test_directory("stored-pairings");
    fs::create_dir_all(&directory).expect("config directory should be created");
    fs::write(
        directory.join("remote-control.json"),
        format!(
            r#"{{
  "version": 0,
  "port": 43188,
  "enabled": false,
  "pairedDevices": [
    {{
      "id": "device-1",
      "name": "Test browser",
      "tokenHash": "token-hash",
      "createdAt": 1,
      "lastSeenAt": 2,
      "expiresAt": {}
    }}
  ]
}}
"#,
            now_millis().saturating_add(WEB_SESSION_TTL_MS)
        ),
    )
    .expect("remote control config should be written");
    let _env = use_user_config_dir(&directory);
    let state = RemoteControlState::default();

    let status = state.status().expect("status should load stored config");

    assert_eq!(status.port, 43188);
    assert_eq!(status.paired_device_count, 1);
    assert_eq!(
        state
            .shared
            .inner
            .lock()
            .expect("state lock")
            .config
            .paired_devices[0]
            .id,
        "device-1"
    );

    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn recorded_progress_updates_remote_snapshot() {
    let state = RemoteControlState::default();

    state.record_progress(
        "task-1",
        &json!({
            "task": "Build the app",
            "mode": "machdoch",
            "state": "executing",
            "message": "Running tests.",
            "executedTools": [],
            "outputSections": [],
            "cancellable": true,
            "actionOutput": {
                "toolName": "shell_command",
                "stream": "stdout",
                "chunk": "tests passed"
            }
        }),
        123,
    );

    let inner = state.shared.inner.lock().expect("state lock");
    let status = create_status_locked(&inner);

    assert_eq!(status.sessions.len(), 1);
    assert_eq!(status.sessions[0].task, "Build the app");
    assert_eq!(status.sessions[0].logs[0].chunk, "tests passed");
}

#[test]
fn status_orders_sessions_by_most_recent_update() {
    let state = RemoteControlState::default();

    state.record_progress("older-task", &json!({ "task": "Older task" }), 100);
    state.record_progress("newer-task", &json!({ "task": "Newer task" }), 200);

    let inner = state.shared.inner.lock().expect("state lock");
    let status = create_status_locked(&inner);

    assert_eq!(status.sessions.len(), 2);
    assert_eq!(status.sessions[0].task_id, "newer-task");
    assert_eq!(status.sessions[1].task_id, "older-task");
}

#[test]
fn snapshots_do_not_expose_approval_prompts() {
    let state = RemoteControlState::default();

    state.record_progress(
        "task-1",
        &json!({
            "task": "Build the app",
            "mode": "machdoch",
            "state": "executing",
            "message": "Waiting.",
            "executedTools": [],
            "outputSections": [],
            "cancellable": true,
            "approvalPrompt": {
                "promptId": "approval-1",
                "title": "Run command",
                "message": "Allow shell command?",
                "details": ["npm test"]
            }
        }),
        123,
    );

    let inner = state.shared.inner.lock().expect("state lock");
    let snapshot = create_snapshot_locked(&inner);
    let payload = serde_json::to_value(&snapshot).expect("snapshot should serialize");

    assert!(payload.get("approvalPrompts").is_none());
}

#[test]
fn snapshots_return_newest_commands_first() {
    let directory = temp_test_directory("command-order");
    let _env = use_user_config_dir(&directory);
    let state = RemoteControlState::default();

    state
        .record_command(&RemoteControlCommandEvent {
            command_id: "command-1".to_string(),
            kind: "cancel".to_string(),
            task_id: Some("task-1".to_string()),
            session_id: None,
            prompt: None,
            title: None,
            tags: None,
            provider: None,
            model: None,
            mode: None,
            reasoning: None,
            workspace: None,
            enabled: None,
            attachment_id: None,
            context_pack_id: None,
            message_id: None,
            job_id: None,
            run_id: None,
            created_at: 100,
        })
        .expect("first command should persist");
    state
        .record_command(&RemoteControlCommandEvent {
            command_id: "command-2".to_string(),
            kind: "cancel".to_string(),
            task_id: Some("task-2".to_string()),
            session_id: None,
            prompt: None,
            title: None,
            tags: None,
            provider: None,
            model: None,
            mode: None,
            reasoning: None,
            workspace: None,
            enabled: None,
            attachment_id: None,
            context_pack_id: None,
            message_id: None,
            job_id: None,
            run_id: None,
            created_at: 200,
        })
        .expect("second command should persist");

    let inner = state.shared.inner.lock().expect("state lock");
    let snapshot = create_snapshot_locked(&inner);
    let payload = serde_json::to_value(&snapshot).expect("snapshot should serialize");
    let commands = payload
        .get("commands")
        .and_then(serde_json::Value::as_array)
        .expect("commands should serialize as an array");

    assert_eq!(
        commands[0]
            .get("commandId")
            .and_then(serde_json::Value::as_str),
        Some("command-2")
    );
    assert_eq!(
        commands[1]
            .get("commandId")
            .and_then(serde_json::Value::as_str),
        Some("command-1")
    );
    drop(inner);
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn remote_commands_remain_pending_until_acknowledged() {
    let directory = temp_test_directory("pending-command");
    let _env = use_user_config_dir(&directory);
    let state = RemoteControlState::default();
    state
        .record_command(&RemoteControlCommandEvent {
            command_id: "pending-command".to_string(),
            kind: "cancel".to_string(),
            task_id: Some("task-1".to_string()),
            session_id: None,
            prompt: None,
            title: None,
            tags: None,
            provider: None,
            model: None,
            mode: None,
            reasoning: None,
            workspace: None,
            enabled: None,
            attachment_id: None,
            context_pack_id: None,
            message_id: None,
            job_id: None,
            run_id: None,
            created_at: 100,
        })
        .expect("pending command should persist");

    assert_eq!(
        state
            .pending_commands()
            .expect("pending commands should load")
            .len(),
        1
    );
    let reloaded_state = RemoteControlState::default();
    assert_eq!(
        reloaded_state
            .pending_commands()
            .expect("persisted pending commands should reload")
            .len(),
        1
    );
    assert!(reloaded_state
        .acknowledge_command("pending-command")
        .expect("command acknowledgement should succeed"));
    assert!(reloaded_state
        .pending_commands()
        .expect("pending commands should reload")
        .is_empty());
    assert!(!reloaded_state
        .acknowledge_command("pending-command")
        .expect("duplicate acknowledgement should be harmless"));
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn command_ids_are_idempotent_and_payload_conflicts_are_rejected() {
    let directory = temp_test_directory("command-idempotency");
    let _env = use_user_config_dir(&directory);
    let state = RemoteControlState::default();
    let first = cancel_command("stable-command", "task-1", 100);

    assert_eq!(
        state
            .record_command(&first)
            .expect("first command should persist"),
        RecordCommandOutcome::Recorded
    );

    let mut retry = first.clone();
    retry.created_at = 200;
    assert_eq!(
        state
            .record_command(&retry)
            .expect("an identical retry should be accepted"),
        RecordCommandOutcome::Duplicate
    );
    assert_eq!(
        state
            .pending_commands()
            .expect("pending commands should load")
            .len(),
        1
    );

    let conflict = cancel_command("stable-command", "task-2", 300);
    assert!(state
        .record_command(&conflict)
        .expect_err("reusing an id for another payload should fail")
        .starts_with("MACHDOCH_REMOTE_COMMAND_ID_CONFLICT:"));

    assert!(state
        .acknowledge_command("stable-command")
        .expect("the original command should acknowledge"));
    let reloaded_state = RemoteControlState::default();
    assert_eq!(
        reloaded_state
            .record_command(&retry)
            .expect("the completed ledger should deduplicate after restart"),
        RecordCommandOutcome::Duplicate
    );
    assert!(reloaded_state
        .pending_commands()
        .expect("a completed duplicate should not be queued again")
        .is_empty());

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn shell_snapshot_preserves_reasoning_fields_after_sanitization() {
    let directory = temp_test_directory("shell-reasoning");
    let _env = use_user_config_dir(&directory);
    let state = RemoteControlState::default();
    let snapshot = serde_json::from_value(json!({
        "version": 1,
        "capturedAt": 123,
        "activeSessionId": "session-1",
        "sessions": [{
            "id": "session-1",
            "title": "Reasoning session",
            "status": "idle",
            "workspace": "C:/workspace",
            "provider": "openai",
            "model": "gpt-5.5",
            "mode": "ask",
            "effectiveMode": "machdoch",
            "reasoning": " high ",
            "effectiveReasoning": " max ",
            "createdAt": 1,
            "updatedAt": 2,
            "archivedAt": null,
            "pinnedAt": null,
            "tags": [],
            "messageCount": 0,
            "promptHistoryCount": 0,
            "attachmentCount": 0,
            "runningTaskId": null,
            "canRename": true,
            "canDelete": true,
            "canArchive": true,
            "canPin": true,
            "canDuplicate": true,
            "canBranch": true,
            "specialKind": null
        }],
        "composer": {
            "sessionId": "session-1",
            "draft": "",
            "provider": "openai",
            "model": "gpt-5.5",
            "mode": "machdoch",
            "defaultMode": "machdoch",
            "reasoning": "medium",
            "defaultReasoning": "low",
            "workspace": "C:/workspace",
            "workspaceLabel": "workspace",
            "canSend": true,
            "sendDisabledReason": null,
            "isExecuting": false,
            "sessionMemoryEnabled": true,
            "globalMemoryAvailable": true,
            "globalMemoryEnabled": true,
            "uiControlAvailable": true,
            "uiControlEnabled": false,
            "uiControlDescription": "available",
            "attachments": [],
            "chooserProviders": ["openai"],
            "matchedContextPackIds": ["pack-1"]
        },
        "runtime": {
            "loading": false,
            "error": null,
            "hasAnyProvider": true,
            "providerStatuses": [{
                "provider": "openai",
                "available": true,
                "reason": null
            }],
            "mode": "machdoch",
            "reasoning": "xhigh",
            "uiControl": {
                "available": true,
                "reason": null
            },
            "webSearch": {
                "available": true,
                "reason": null
            }
        },
        "contextPacks": [{
            "id": "pack-1",
            "name": "Pack",
            "workspace": "C:/workspace",
            "instructionsPreview": "Use project conventions.",
            "promptPreview": "Build carefully.",
            "attachmentCount": 0,
            "variables": [],
            "matched": true,
            "provider": "openai",
            "model": "gpt-5.5",
            "mode": "machdoch",
            "reasoning": "minimal"
        }]
    }))
    .expect("shell snapshot should deserialize");

    state
        .update_shell_snapshot(snapshot)
        .expect("shell snapshot should update");

    let inner = state.shared.inner.lock().expect("state lock");
    let payload = serde_json::to_value(
        create_snapshot_locked(&inner)
            .shell
            .expect("shell snapshot should be stored"),
    )
    .expect("shell snapshot should serialize");

    assert_eq!(payload["sessions"][0]["reasoning"].as_str(), Some("high"));
    assert_eq!(
        payload["sessions"][0]["effectiveReasoning"].as_str(),
        Some("max")
    );
    assert_eq!(payload["composer"]["reasoning"].as_str(), Some("medium"));
    assert_eq!(
        payload["composer"]["defaultReasoning"].as_str(),
        Some("low")
    );
    assert_eq!(payload["runtime"]["reasoning"].as_str(), Some("xhigh"));
    assert_eq!(
        payload["contextPacks"][0]["reasoning"].as_str(),
        Some("minimal")
    );

    drop(inner);
    let _ = fs::remove_dir_all(&directory);
}

#[test]
fn older_shell_snapshot_cannot_overwrite_a_newer_snapshot() {
    let directory = temp_test_directory("shell-order");
    let _env = use_user_config_dir(&directory);
    let state = RemoteControlState::default();
    let newer = serde_json::from_value(json!({
        "version": 1,
        "capturedAt": 200,
        "activeSessionId": "newer"
    }))
    .expect("newer shell snapshot should deserialize");
    let older = serde_json::from_value(json!({
        "version": 1,
        "capturedAt": 100,
        "activeSessionId": "older"
    }))
    .expect("older shell snapshot should deserialize");

    state
        .update_shell_snapshot(newer)
        .expect("newer snapshot should be accepted");
    state
        .update_shell_snapshot(older)
        .expect("older snapshot should be ignored without failing");

    let inner = state.shared.inner.lock().expect("state lock");
    let shell = inner.shell.as_ref().expect("shell snapshot should exist");
    assert_eq!(shell.captured_at, 200);
    assert_eq!(shell.active_session_id.as_deref(), Some("newer"));
    drop(inner);
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn mission_control_html_exposes_reasoning_control_wiring() {
    let html = mission_control_html();

    assert!(html.contains(r#"id="reasoningSelect""#));
    assert!(html.contains(r#"aria-label="Reasoning""#));
    for reasoning in [
        "default", "none", "minimal", "low", "medium", "high", "xhigh", "max",
    ] {
        assert!(
            html.contains(&format!(r#"<option value="{reasoning}">"#)),
            "reasoning option {reasoning} should be rendered"
        );
    }
    assert!(html.contains("const supportedReasoningModes = ["));
    assert!(html.contains("session.effectiveReasoning"));
    assert!(html.contains("composer.defaultReasoning"));
    assert!(html.contains(r#"kind: "set-session-reasoning""#));
    assert!(html.contains("reasoning: reasoningSelect.value"));
    assert!(html.contains("supportedReasoningModes.includes(reasoningSelect.value)"));
}

#[test]
fn disabled_status_omits_handoff_secrets() {
    let status = create_status_locked(&RemoteControlInner::default());
    let payload = serde_json::to_value(&status).expect("status should serialize");

    assert!(!status.enabled);
    assert!(status.display_url.is_none());
    assert!(status.qr_svg.is_none());
    assert!(status.token_hint.is_none());
    assert!(payload.get("displayUrl").is_none());
    assert!(payload.get("qrSvg").is_none());
    assert!(payload.get("tokenHint").is_none());
}

#[test]
fn token_hint_uses_last_six_characters_without_exposing_full_token() {
    assert_eq!(create_token_hint("short"), "...short");
    assert_eq!(create_token_hint("abcdefghijklmnopqrstuvwxyz"), "...uvwxyz");
}
