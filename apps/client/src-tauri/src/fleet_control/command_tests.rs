use machdoch_fleet_protocol::{ProductCommand, ProductCommandKind};

use super::{
    commands::{
        command_payload_hash, command_payloads_match, create_command_record, normalize_command,
        truncate_chars,
    },
    MAX_COMMAND_TEXT_CHARS,
};

#[test]
fn remote_iterations_and_queue_edits_preserve_the_current_payload() {
    let request: ProductCommand = serde_json::from_value(serde_json::json!({
        "kind": "submit-message", "commandId": "iterations", "sessionId": "session-1",
        "prompt": "Work on this", "promptEnhancementMode": "off", "interviewEnabled": false,
        "iterationCount": 3, "iterationMode": "repeat-prompt-and-continue", "runningAction": "steer"
    }))
    .unwrap();
    let event = normalize_command(request).unwrap();
    assert_eq!(event.iteration_count, Some(3));
    assert_eq!(
        event.iteration_mode.as_deref(),
        Some("repeat-prompt-and-continue")
    );
    assert_eq!(event.running_action.as_deref(), Some("steer"));
    let mut changed = event.clone();
    changed.iteration_count = Some(2);
    assert!(!command_payloads_match(&event, &changed));
    assert_ne!(command_payload_hash(&event), command_payload_hash(&changed));
    let blank: ProductCommand = serde_json::from_value(serde_json::json!({
        "kind": "update-queued-message", "sessionId": "session-1", "messageId": "message-1", "prompt": " \n "
    })).unwrap();
    assert_eq!(
        normalize_command(blank).unwrap().prompt.as_deref(),
        Some(" \n ")
    );
}

#[test]
fn context_pack_values_are_part_of_the_replay_payload() {
    let request: ProductCommand = serde_json::from_value(serde_json::json!({
        "kind": "apply-context-pack", "commandId": "variables", "sessionId": "session-1",
        "contextPackId": "pack-1", "variableValues": { "project": "One" }
    }))
    .unwrap();
    let event = normalize_command(request).unwrap();
    let mut changed = event.clone();
    changed
        .variable_values
        .as_mut()
        .unwrap()
        .insert("project".to_string(), "Two".to_string());
    assert!(!command_payloads_match(&event, &changed));
    assert_ne!(command_payload_hash(&event), command_payload_hash(&changed));
}

#[test]
fn quick_chat_is_a_targetless_command_with_stable_replay_identity() {
    let command = normalize_command(
        serde_json::from_value(serde_json::json!({
            "kind": "open-quick-chat",
            "commandId": "open-quick-verification"
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(command.kind, "open-quick-chat");
    assert!(command.session_id.is_none());
    assert!(command_payloads_match(&command, &command));
    assert_eq!(
        command_payload_hash(&command),
        command_payload_hash(&command)
    );
}

#[test]
fn pose_chat_preserves_the_scene_and_replay_identity() {
    let scene = serde_json::json!({
        "aspectRatio": "4:5",
        "people": [{ "pose": "waving", "x": 0.5, "y": 0.8, "scale": 0.6, "mirror": false }]
    });
    let request: ProductCommand = serde_json::from_value(serde_json::json!({
        "kind": "create-session", "commandId": "pose-chat", "specialKind": "pose", "poseScene": scene
    })).unwrap();
    let event = normalize_command(request).unwrap();
    assert_eq!(event.special_kind.as_deref(), Some("pose"));
    assert_eq!(event.pose_scene.as_ref(), Some(&scene));
    let mut changed = event.clone();
    changed.pose_scene.as_mut().unwrap()["people"][0]["mirror"] = serde_json::json!(true);
    assert!(!command_payloads_match(&event, &changed));
    assert_ne!(command_payload_hash(&event), command_payload_hash(&changed));
    changed = event.clone();
    changed.special_kind = None;
    assert!(!command_payloads_match(&event, &changed));
    assert_ne!(command_payload_hash(&event), command_payload_hash(&changed));
}

#[test]
fn prompt_history_preserves_exact_drafts_and_attachment_replay_identity() {
    let history = serde_json::json!({
        "index": 4, "prompt": "Earlier 🌿\n", "attachmentIds": ["historical-file"],
        "previousDraft": "Current 🌿\n", "previousAttachmentIds": ["current-file"]
    });
    let request: ProductCommand = serde_json::from_value(serde_json::json!({
        "kind": "restore-prompt-history", "sessionId": "session-1", "prompt": "  Edited 🌿\n\t", "history": history
    })).unwrap();
    let event = normalize_command(request).unwrap();
    assert_eq!(event.prompt.as_deref(), Some("  Edited 🌿\n\t"));
    assert_eq!(
        serde_json::to_value(event.history.as_ref().unwrap()).unwrap(),
        history
    );
    let mut changed = event.clone();
    changed.history.as_mut().unwrap().attachment_ids = vec!["changed-file".to_owned()];
    assert!(!command_payloads_match(&event, &changed));
    assert_ne!(command_payload_hash(&event), command_payload_hash(&changed));
    let draft = normalize_command(ProductCommand {
        session_id: Some("session-1".to_owned()),
        prompt: Some("  Exact draft 🌿\n\t".to_owned()),
        ..command_request(ProductCommandKind::UpdateDraft)
    })
    .unwrap();
    assert_eq!(draft.prompt.as_deref(), Some("  Exact draft 🌿\n\t"));
}

#[test]
fn adaptive_overrides_preserve_session_targeting_and_replay_identity() {
    for mode in ["default", "enabled", "disabled"] {
        let request: ProductCommand = serde_json::from_value(serde_json::json!({
            "kind": "set-adaptive-controller", "commandId": "adaptive", "sessionId": "session-1", "mode": mode
        })).unwrap();
        let event = normalize_command(request).unwrap();
        assert_eq!(event.session_id.as_deref(), Some("session-1"));
        assert_eq!(event.mode.as_deref(), Some(mode));
        let mut changed = event.clone();
        changed.mode = Some(
            if mode == "enabled" {
                "disabled"
            } else {
                "enabled"
            }
            .to_string(),
        );
        assert!(!command_payloads_match(&event, &changed));
        assert_ne!(command_payload_hash(&event), command_payload_hash(&changed));
    }
}

fn command_request(kind: ProductCommandKind) -> ProductCommand {
    ProductCommand {
        history: None,
        special_kind: None,
        pose_scene: None,
        name: None,
        repository: None,
        branch: None,
        shallow: None,
        initialize_git: None,
        project_id: None,
        command_id: None,
        kind,
        task_id: None,
        session_id: None,
        prompt: None,
        goal_objective: None,
        iteration_count: None,
        iteration_mode: None,
        running_action: None,
        direction: None,
        target_index: None,
        variable_values: None,
        paths: None,
        context_pack: None,
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
        destination_workspace: None,
        enabled: None,
        memory_id: None,
        attachment_id: None,
        context_pack_id: None,
        message_id: None,
        run_id: None,
        flow_id: None,
        scope: None,
        parameters: None,
        max_transitions: None,
        isolated: None,
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
            error.contains("default, none, minimal, low, medium, high, xhigh, max, ultra, aeon"),
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
fn workspace_relink_destinations_are_part_of_command_identity() {
    let event = normalize_command(ProductCommand {
        workspace: Some("/projects/demo".to_string()),
        destination_workspace: Some("/projects/new".to_string()),
        ..command_request(ProductCommandKind::RelinkWorkspace)
    })
    .expect("workspace relink should normalize");
    assert!(event.session_id.is_none());
    assert_eq!(
        event.destination_workspace.as_deref(),
        Some("/projects/new")
    );
    let mut changed = event.clone();
    changed.destination_workspace = Some("/projects/another".to_string());
    assert!(!command_payloads_match(&event, &changed));
    assert_ne!(command_payload_hash(&event), command_payload_hash(&changed));
}

#[test]
fn submitted_message_prompts_are_trimmed_without_losing_native_text() {
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
        MAX_COMMAND_TEXT_CHARS + 1
    );
    assert_eq!(event.enabled, Some(false));
}

#[test]
fn edited_message_prompts_preserve_unicode_beyond_the_snapshot_limit() {
    let text = "Grüße 🌿\n".repeat(2_000);
    let event = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        message_id: Some("message-1".to_string()),
        prompt: Some(format!("  {text}  ")),
        ..command_request(ProductCommandKind::EditMessage)
    })
    .expect("valid edit should normalize");
    assert_eq!(event.prompt.as_deref(), Some(text.trim()));
}

#[test]
fn submitted_goals_are_preserved_in_events_and_command_identity() {
    let mut event = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        prompt: Some("Fix auth".to_string()),
        goal_objective: Some("  All auth tests pass\nVerify sign-out  ".to_string()),
        prompt_enhancement_mode: Some("off".to_string()),
        interview_enabled: Some(false),
        ..command_request(ProductCommandKind::SubmitMessage)
    })
    .expect("valid goal should normalize");

    assert_eq!(
        event.goal_objective.as_deref(),
        Some("All auth tests pass\nVerify sign-out")
    );
    let original = event.clone();
    event.goal_objective = Some("Verify password reset".to_string());
    assert!(!command_payloads_match(&original, &event));
    assert_ne!(
        command_payload_hash(&original),
        command_payload_hash(&event)
    );
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
        model_id: Some("openai:gpt-image-2.5-sunburst".to_string()),
        target: Some("image".to_string()),
        aspect_ratio: Some("1:1".to_string()),
        output_count: Some(2),
        output_format: Some("png".to_string()),
        transparent_background: Some(true),
        ..command_request(ProductCommandKind::GenerateMedia)
    })
    .expect("a complete media recipe should normalize");

    assert_eq!(event.kind, "generate-media");
    assert_eq!(
        event.model_id.as_deref(),
        Some("openai:gpt-image-2.5-sunburst")
    );
    assert_eq!(event.output_count, Some(2));

    let error = normalize_command(ProductCommand {
        prompt: Some("Create a blue geometric owl".to_string()),
        model_id: Some("openai:gpt-image-2.5-sunburst".to_string()),
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

#[test]
fn message_edits_and_replays_preserve_the_session_and_message_target() {
    let edit = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        message_id: Some("message-1".to_string()),
        prompt: Some("Edited request 🌿".to_string()),
        ..command_request(ProductCommandKind::EditMessage)
    })
    .unwrap();
    assert_eq!(edit.kind, "edit-message");
    assert_eq!(edit.session_id.as_deref(), Some("session-1"));
    assert_eq!(edit.message_id.as_deref(), Some("message-1"));
    assert_eq!(edit.prompt.as_deref(), Some("Edited request 🌿"));
    let replay = normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        message_id: Some("message-1".to_string()),
        ..command_request(ProductCommandKind::ReplayMessage)
    })
    .unwrap();
    assert_eq!(replay.kind, "replay-message");
    assert_eq!(replay.message_id.as_deref(), Some("message-1"));
    assert!(normalize_command(ProductCommand {
        session_id: Some("session-1".to_string()),
        ..command_request(ProductCommandKind::ReplayMessage)
    })
    .is_err());
}

#[test]
fn session_order_and_time_actions_require_a_distinct_session_target() {
    for kind in [
        ProductCommandKind::ResetSessionTime,
        ProductCommandKind::MoveSessionToTop,
    ] {
        assert!(normalize_command(command_request(kind)).is_err());
        let event = normalize_command(ProductCommand {
            session_id: Some("session-1".to_owned()),
            ..command_request(kind)
        })
        .unwrap();
        assert_eq!(event.kind, kind.as_str());
        assert_eq!(event.session_id.as_deref(), Some("session-1"));
        let mut changed = event.clone();
        changed.session_id = Some("session-2".to_owned());
        assert!(!command_payloads_match(&event, &changed));
    }
}
