use machdoch_fleet_protocol::{ProductCommand, ProductCommandKind};

use super::{
    commands::{create_command_record, normalize_command, truncate_chars},
    MAX_COMMAND_TEXT_CHARS,
};

fn command_request(kind: ProductCommandKind) -> ProductCommand {
    ProductCommand {
        command_id: None,
        kind,
        task_id: None,
        session_id: None,
        prompt: None,
        title: None,
        tags: None,
        provider: None,
        model: None,
        model_id: None,
        mode: None,
        reasoning: None,
        prompt_enhancement_mode: None,
        interview_enabled: None,
        workspace: None,
        enabled: None,
        memory_id: None,
        attachment_id: None,
        context_pack_id: None,
        message_id: None,
        job_id: None,
        run_id: None,
        flow_id: None,
        scope: None,
        parameters: None,
        max_transitions: None,
        target: None,
        aspect_ratio: None,
        output_count: None,
        output_format: None,
        transparent_background: None,
    }
}

#[test]
fn client_command_ids_are_preserved_for_idempotent_retries() {
    let event = normalize_command(ProductCommand {
        command_id: Some(" client-command-1 ".to_string()),
        session_id: Some("session-1".to_string()),
        ..command_request(ProductCommandKind::ActivateSession)
    })
    .expect("a client command id should be accepted");

    assert_eq!(event.command_id, "client-command-1");
}

#[test]
fn grouped_commands_require_their_target_fields() {
    let cases = [
        (ProductCommandKind::Cancel, "taskId"),
        (ProductCommandKind::RenameSession, "sessionId"),
        (ProductCommandKind::ApplyContextPack, "contextPackId"),
        (ProductCommandKind::SpeakMessage, "messageId"),
        (ProductCommandKind::SchedulerPause, "jobId"),
        (ProductCommandKind::SchedulerRetryRun, "runId"),
        (ProductCommandKind::SetUiControl, "enabled value"),
        (ProductCommandKind::ForgetSessionMemory, "memoryId"),
    ];

    for (kind, expected_message) in cases {
        let mut request = command_request(kind);
        if matches!(
            kind,
            ProductCommandKind::ApplyContextPack
                | ProductCommandKind::SpeakMessage
                | ProductCommandKind::SetUiControl
                | ProductCommandKind::ForgetSessionMemory
        ) {
            request.session_id = Some("session-1".to_string());
        }

        let error = normalize_command(request).expect_err("missing target field should reject");

        assert!(
            error.contains(expected_message),
            "expected {} error to contain {expected_message}, got {error}",
            kind.as_str()
        );
    }
}

#[test]
fn forget_session_memory_preserves_its_target() {
    let event = normalize_command(ProductCommand {
        session_id: Some(" session-1 ".to_string()),
        memory_id: Some(" memory-1 ".to_string()),
        ..command_request(ProductCommandKind::ForgetSessionMemory)
    })
    .expect("session memory target should normalize");

    assert_eq!(event.session_id.as_deref(), Some("session-1"));
    assert_eq!(event.memory_id.as_deref(), Some("memory-1"));
    assert_eq!(
        create_command_record(&event).target_preview.as_deref(),
        Some("memory:memory-1")
    );
}

#[test]
fn submit_message_commands_require_prompt_text() {
    let result = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        prompt: Some("   ".to_string()),
        prompt_enhancement_mode: Some("off".to_string()),
        interview_enabled: Some(false),
        ..command_request(ProductCommandKind::SubmitMessage)
    });

    assert!(result.is_err());

    let missing_interview = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        prompt: Some("Run the task".to_string()),
        prompt_enhancement_mode: Some("off".to_string()),
        ..command_request(ProductCommandKind::SubmitMessage)
    });

    assert!(missing_interview
        .expect_err("message submission requires an explicit interview state")
        .contains("interviewEnabled"));
}

#[test]
fn set_session_mode_accepts_only_supported_modes() {
    let invalid = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        mode: Some("auto".to_string()),
        ..command_request(ProductCommandKind::SetSessionMode)
    });

    assert!(invalid
        .expect_err("invalid session mode should be rejected")
        .contains("ask or machdoch"));

    let allowed = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        mode: Some("ask".to_string()),
        ..command_request(ProductCommandKind::SetSessionMode)
    })
    .expect("supported session mode should normalize");

    assert_eq!(allowed.mode.as_deref(), Some("ask"));
}

#[test]
fn set_session_reasoning_requires_supported_reasoning() {
    for reasoning in [None, Some("   ".to_string()), Some("maximum".to_string())] {
        let error = normalize_command(ProductCommand {
            session_id: Some("session-1".to_string()),
            reasoning,
            ..command_request(ProductCommandKind::SetSessionReasoning)
        })
        .expect_err("missing or unsupported reasoning should reject");

        assert!(
            error.contains("default, none, minimal, low, medium, high, xhigh, max, ultra"),
            "unexpected reasoning error: {error}"
        );
    }

    let allowed = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        reasoning: Some(" high ".to_string()),
        ..command_request(ProductCommandKind::SetSessionReasoning)
    })
    .expect("supported reasoning should normalize");

    assert_eq!(allowed.kind, "set-session-reasoning");
    assert_eq!(allowed.session_id.as_deref(), Some("session-1"));
    assert_eq!(allowed.reasoning.as_deref(), Some("high"));
}

#[test]
fn toggle_commands_preserve_false_enabled_values() {
    let event = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        enabled: Some(false),
        ..command_request(ProductCommandKind::SetUiControl)
    })
    .expect("false enabled values are explicit toggle inputs");

    assert_eq!(event.session_id.as_deref(), Some("session-1"));
    assert_eq!(event.enabled, Some(false));
}

#[test]
fn submitted_message_prompts_are_trimmed_and_truncated() {
    let prompt = format!("  {}  ", "x".repeat(MAX_COMMAND_TEXT_CHARS + 1));
    let event = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        prompt: Some(prompt),
        prompt_enhancement_mode: Some("simple".to_string()),
        interview_enabled: Some(false),
        ..command_request(ProductCommandKind::SubmitMessage)
    })
    .expect("valid message command should normalize");

    assert_eq!(
        event.prompt.expect("prompt").chars().count(),
        MAX_COMMAND_TEXT_CHARS
    );
    assert_eq!(event.enabled, Some(false));
}

#[test]
fn ralph_run_commands_require_a_complete_runtime_request() {
    let event = normalize_command(ProductCommand {
        workspace: Some(" C:\\workspace ".to_string()),
        flow_id: Some(" release ".to_string()),
        scope: Some("workspace".to_string()),
        parameters: Some(
            [
                (" environment ".to_string(), " production ".to_string()),
                ("version".to_string(), "1.2.3".to_string()),
            ]
            .into(),
        ),
        provider: Some("openai".to_string()),
        model: Some("gpt-5.4".to_string()),
        reasoning: Some("high".to_string()),
        max_transitions: Some(64),
        ..command_request(ProductCommandKind::RalphRun)
    })
    .expect("a complete RALPH run should normalize");

    assert_eq!(event.kind, "ralph-run");
    assert_eq!(event.workspace.as_deref(), Some("C:\\workspace"));
    assert_eq!(event.flow_id.as_deref(), Some("release"));
    assert_eq!(event.scope.as_deref(), Some("workspace"));
    assert_eq!(
        event
            .parameters
            .as_ref()
            .and_then(|parameters| parameters.get("environment"))
            .map(String::as_str),
        Some(" production ")
    );
    assert_eq!(event.max_transitions, Some(64));
}

#[test]
fn ralph_resume_commands_require_run_scope_workspace_and_model() {
    let error = normalize_command(ProductCommand {
        run_id: Some("run-1".to_string()),
        scope: Some("workspace".to_string()),
        workspace: Some("C:\\workspace".to_string()),
        reasoning: Some("high".to_string()),
        ..command_request(ProductCommandKind::RalphResumeRun)
    })
    .expect_err("RALPH resume requires a model selection");

    assert!(error.contains("provider and model"));
}

#[test]
fn ralph_run_commands_reject_duplicate_normalized_parameter_names() {
    let error = normalize_command(ProductCommand {
        workspace: Some("C:\\workspace".to_string()),
        flow_id: Some("release".to_string()),
        scope: Some("workspace".to_string()),
        parameters: Some(
            [
                ("environment".to_string(), "staging".to_string()),
                (" environment ".to_string(), "production".to_string()),
            ]
            .into(),
        ),
        provider: Some("openai".to_string()),
        model: Some("gpt-5.6".to_string()),
        reasoning: Some("high".to_string()),
        ..command_request(ProductCommandKind::RalphRun)
    })
    .expect_err("normalized RALPH parameter names must remain unique");

    assert!(error.contains("unique after trimming"));
}

#[test]
fn media_generation_requires_a_complete_bounded_recipe() {
    let event = normalize_command(ProductCommand {
        prompt: Some("Create a blue geometric owl".to_string()),
        model_id: Some("openai:gpt-image-2".to_string()),
        target: Some("image".to_string()),
        aspect_ratio: Some("1:1".to_string()),
        output_count: Some(2),
        output_format: Some("png".to_string()),
        transparent_background: Some(true),
        ..command_request(ProductCommandKind::GenerateMedia)
    })
    .expect("a complete media recipe should normalize");

    assert_eq!(event.kind, "generate-media");
    assert_eq!(event.model_id.as_deref(), Some("openai:gpt-image-2"));
    assert_eq!(event.output_count, Some(2));

    let error = normalize_command(ProductCommand {
        prompt: Some("Create a blue geometric owl".to_string()),
        model_id: Some("openai:gpt-image-2".to_string()),
        target: Some("svg".to_string()),
        aspect_ratio: Some("1:1".to_string()),
        output_count: Some(1),
        output_format: Some("png".to_string()),
        transparent_background: Some(false),
        ..command_request(ProductCommandKind::GenerateMedia)
    })
    .expect_err("SVG generation must produce SVG output");

    assert!(error.contains("output format"));
}

#[test]
fn command_records_prefer_session_target_preview() {
    let event = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        prompt: Some("queued prompt".to_string()),
        ..command_request(ProductCommandKind::UpdateDraft)
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
