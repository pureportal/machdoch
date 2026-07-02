use super::{
    commands::{create_command_record, normalize_command, truncate_chars, RemoteCommandRequest},
    MAX_COMMAND_TEXT_CHARS,
};

fn command_request(kind: &str) -> RemoteCommandRequest {
    RemoteCommandRequest {
        kind: kind.to_string(),
        task_id: None,
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
    }
}

#[test]
fn grouped_commands_require_their_target_fields() {
    let cases = [
        ("cancel", "taskId"),
        ("rename-session", "sessionId"),
        ("apply-context-pack", "contextPackId"),
        ("speak-message", "messageId"),
        ("scheduler-pause", "jobId"),
        ("scheduler-retry-run", "runId"),
        ("set-ui-control", "enabled value"),
    ];

    for (kind, expected_message) in cases {
        let mut request = command_request(kind);
        if matches!(
            kind,
            "apply-context-pack" | "speak-message" | "set-ui-control"
        ) {
            request.session_id = Some("session-1".to_string());
        }

        let error = normalize_command(request).expect_err("missing target field should reject");

        assert!(
            error.contains(expected_message),
            "expected {kind} error to contain {expected_message}, got {error}"
        );
    }
}

#[test]
fn follow_up_commands_require_prompt_text() {
    let result = normalize_command(RemoteCommandRequest {
        task_id: Some("task-1".to_string()),
        prompt: Some("   ".to_string()),
        ..command_request("follow-up")
    });

    assert!(result.is_err());
}

#[test]
fn approval_decision_commands_are_not_supported() {
    let result = normalize_command(RemoteCommandRequest {
        task_id: Some("task-1".to_string()),
        prompt: None,
        ..command_request("approval-decision")
    });

    assert!(result.is_err());
}

#[test]
fn set_session_mode_accepts_only_supported_modes() {
    let invalid = normalize_command(RemoteCommandRequest {
        session_id: Some("session-1".to_string()),
        mode: Some("auto".to_string()),
        ..command_request("set-session-mode")
    });

    assert!(invalid
        .expect_err("invalid session mode should be rejected")
        .contains("ask or machdoch"));

    let allowed = normalize_command(RemoteCommandRequest {
        session_id: Some("session-1".to_string()),
        mode: Some("ask".to_string()),
        ..command_request("set-session-mode")
    })
    .expect("supported session mode should normalize");

    assert_eq!(allowed.mode.as_deref(), Some("ask"));
}

#[test]
fn set_session_reasoning_requires_supported_reasoning() {
    for reasoning in [None, Some("   ".to_string()), Some("maximum".to_string())] {
        let error = normalize_command(RemoteCommandRequest {
            session_id: Some("session-1".to_string()),
            reasoning,
            ..command_request("set-session-reasoning")
        })
        .expect_err("missing or unsupported reasoning should reject");

        assert!(
            error.contains("default, none, minimal, low, medium, high, xhigh, max"),
            "unexpected reasoning error: {error}"
        );
    }

    let allowed = normalize_command(RemoteCommandRequest {
        session_id: Some("session-1".to_string()),
        reasoning: Some(" high ".to_string()),
        ..command_request("set-session-reasoning")
    })
    .expect("supported reasoning should normalize");

    assert_eq!(allowed.kind, "set-session-reasoning");
    assert_eq!(allowed.session_id.as_deref(), Some("session-1"));
    assert_eq!(allowed.reasoning.as_deref(), Some("high"));
}

#[test]
fn toggle_commands_preserve_false_enabled_values() {
    let event = normalize_command(RemoteCommandRequest {
        session_id: Some("session-1".to_string()),
        enabled: Some(false),
        ..command_request("set-ui-control")
    })
    .expect("false enabled values are explicit toggle inputs");

    assert_eq!(event.session_id.as_deref(), Some("session-1"));
    assert_eq!(event.enabled, Some(false));
}

#[test]
fn follow_up_prompts_are_trimmed_and_truncated() {
    let prompt = format!("  {}  ", "x".repeat(MAX_COMMAND_TEXT_CHARS + 1));
    let event = normalize_command(RemoteCommandRequest {
        task_id: Some("task-1".to_string()),
        prompt: Some(prompt),
        ..command_request("follow-up")
    })
    .expect("valid follow-up command should normalize");

    assert_eq!(
        event.prompt.expect("prompt").chars().count(),
        MAX_COMMAND_TEXT_CHARS
    );
}

#[test]
fn command_records_prefer_session_target_preview() {
    let event = normalize_command(RemoteCommandRequest {
        session_id: Some("session-1".to_string()),
        prompt: Some("queued prompt".to_string()),
        ..command_request("update-draft")
    })
    .expect("valid session command should normalize");
    let record = create_command_record(&event);

    assert_eq!(record.target_preview.as_deref(), Some("session:session-1"));
    assert_eq!(record.prompt_preview.as_deref(), Some("queued prompt"));
}

#[test]
fn truncate_chars_preserves_unicode_character_boundaries() {
    assert_eq!(
        truncate_chars("\u{00e5}\u{00df}\u{00e7}d\u{00e9}", 3),
        "\u{00e5}\u{00df}\u{00e7}"
    );
}
