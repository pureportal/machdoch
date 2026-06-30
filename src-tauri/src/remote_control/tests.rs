use axum::http::{HeaderMap, HeaderValue};
use serde_json::json;

use super::{
    auth::{
        constant_time_eq, hash_remote_control_token, headers_are_authorized,
        state_changing_headers_allowed,
    },
    create_snapshot_locked, create_status_locked, now_millis, RemoteControlInner,
    RemoteControlPairedDevice, RemoteControlState, WEB_SESSION_COOKIE_NAME, WEB_SESSION_TTL_MS,
};

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
