use machdoch_fleet_protocol::{HostRequest, HostResponse, ProductCommand, MAX_COMPOSER_TEXT_CHARACTERS};
use serde_json::{json, Value};

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../fixtures/composer-conformance.json"))
        .expect("Composer fixtures must be valid JSON.")
}

fn snapshot_with_composer(fixtures: &Value, composer: &Value) -> Value {
    let mut snapshot = fixtures["baseSnapshot"].clone();
    snapshot["shell"]["composer"]
        .as_object_mut()
        .expect("Base snapshot must define a composer.")
        .extend(
            composer
                .as_object()
                .expect("Composer overrides must be an object.")
                .clone(),
        );
    snapshot
}

fn assert_snapshot_acceptance(snapshot: Value, accepted: bool, name: &str) {
    let payload = json!({"type": "productSnapshot", "snapshot": snapshot});
    let decoded = serde_json::from_value::<HostResponse>(payload.clone());
    assert_eq!(decoded.is_ok(), accepted, "{name}: {decoded:?}");
    let encoded = serde_json::to_value(HostResponse::ProductSnapshot {
        snapshot: payload["snapshot"].clone(),
    });
    assert_eq!(encoded.is_ok(), accepted, "{name}: {encoded:?}");
    if let Ok(response) = decoded {
        let round_trip = serde_json::to_value(response).expect("Snapshot must serialize.");
        assert_eq!(round_trip, payload, "{name}");
        assert!(
            serde_json::from_value::<HostResponse>(round_trip).is_ok(),
            "{name}"
        );
    }
}

#[test]
fn composer_commands_conform_at_product_and_host_request_boundaries() {
    let fixtures = fixtures();
    for entry in fixtures["commands"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        let accepted = entry["accepted"].as_bool().unwrap();
        let decoded = serde_json::from_value::<ProductCommand>(entry["command"].clone());
        assert_eq!(decoded.is_ok(), accepted, "{name}: {decoded:?}");
        let request = json!({
            "type": "executeProductCommand",
            "command": entry["command"],
        });
        assert_eq!(
            serde_json::from_value::<HostRequest>(request).is_ok(),
            accepted,
            "{name}",
        );
        if let Ok(command) = decoded {
            let encoded = serde_json::to_value(command).expect("Command must serialize.");
            let expected = entry.get("expected").unwrap_or(&entry["command"]);
            assert_eq!(&encoded, expected, "{name}");
            let round_trip = serde_json::from_value::<ProductCommand>(encoded.clone())
                .expect("Command must round trip.");
            assert_eq!(serde_json::to_value(round_trip).unwrap(), encoded, "{name}");
        }
    }
}

#[test]
fn composer_snapshots_conform_at_product_and_host_response_boundaries() {
    let fixtures = fixtures();
    for entry in fixtures["snapshots"].as_array().unwrap() {
        assert_snapshot_acceptance(
            snapshot_with_composer(&fixtures, &entry["composer"]),
            entry["accepted"].as_bool().unwrap(),
            entry["name"].as_str().unwrap(),
        );
    }
}

#[test]
fn composer_text_limits_count_utf16_units_and_preserve_blank_queue_edits() {
    let fixtures = fixtures();
    let command = json!({
        "kind": "update-queued-message",
        "sessionId": "session-1",
        "messageId": "message-1",
        "prompt": "",
    });
    for prompt in [
        "".to_string(),
        " \n ".to_string(),
        "x".repeat(8_001),
        "😀".repeat(MAX_COMPOSER_TEXT_CHARACTERS / 2),
    ] {
        let mut payload = command.clone();
        payload["prompt"] = Value::String(prompt);
        let decoded = serde_json::from_value::<ProductCommand>(payload.clone())
            .expect("Bounded queue edit must deserialize.");
        assert_eq!(serde_json::to_value(decoded).unwrap(), payload);
    }
    let mut oversized = command;
    oversized["prompt"] = Value::String("😀".repeat(MAX_COMPOSER_TEXT_CHARACTERS / 2) + "x");
    assert!(serde_json::from_value::<ProductCommand>(oversized).is_err());

    let queued = json!({
        "id": "message-1", "content": "", "attachments": [], "status": "queued", "createdAt": 0,
    });
    for (field, maximum) in [
        ("id", 8_000),
        ("content", 8_000),
        ("failureMessage", 12_000),
    ] {
        for text in ["x".repeat(maximum), "😀".repeat(maximum / 2)] {
            let mut message = queued.clone();
            message[field] = Value::String(text.clone());
            assert_snapshot_acceptance(
                snapshot_with_composer(&fixtures, &json!({"queuedMessages": [message]})),
                true,
                field,
            );
            message[field] = Value::String(text + "x");
            assert_snapshot_acceptance(
                snapshot_with_composer(&fixtures, &json!({"queuedMessages": [message]})),
                false,
                field,
            );
        }
    }
    let reason = "😀".repeat(6_000);
    assert_snapshot_acceptance(
        snapshot_with_composer(&fixtures, &json!({"imageInputDisabledReason": reason})),
        true,
        "image input reason at limit",
    );
    assert_snapshot_acceptance(
        snapshot_with_composer(&fixtures, &json!({"imageInputDisabledReason": reason + "x"})),
        false,
        "image input reason exceeds limit",
    );
}

#[test]
fn composer_collection_limits_accept_the_final_slot_and_reject_overflow() {
    let fixtures = fixtures();
    for count in [512, 513] {
        let messages: Vec<_> = (0..count)
            .map(|index| json!({
                "id": format!("message-{index}"),
                "content": "",
                "attachments": [],
                "status": "queued",
                "createdAt": 0,
            }))
            .collect();
        assert_snapshot_acceptance(
            snapshot_with_composer(&fixtures, &json!({"queuedMessages": messages})),
            count == 512,
            "queued message count",
        );
    }
    for count in [64, 65] {
        let attachments: Vec<_> = (0..count)
            .map(|index| json!({
                "id": format!("attachment-{index}"), "source": "path",
                "kind": "file", "name": "", "path": "",
            }))
            .collect();
        let composer = json!({
            "queuedMessages": [{
                "id": "message-1", "content": "", "attachments": attachments,
                "status": "queued", "createdAt": 0,
            }],
        });
        assert_snapshot_acceptance(
            snapshot_with_composer(&fixtures, &composer),
            count == 64,
            "queued attachment count",
        );
        let variables: serde_json::Map<_, _> = (0..count)
            .map(|index| (format!("key-{index}"), Value::String(String::new())))
            .collect();
        let command = json!({
            "kind": "apply-context-pack", "sessionId": "session-1",
            "contextPackId": "pack-1", "variableValues": variables,
        });
        assert_eq!(
            serde_json::from_value::<ProductCommand>(command).is_ok(),
            count == 64
        );
    }
}

#[test]
fn context_variable_bounds_preserve_keys_and_count_utf16_units() {
    let command = json!({
        "kind": "apply-context-pack", "sessionId": "session-1", "contextPackId": "pack-1",
    });
    let key = "😀".repeat(120);
    let value = "😀".repeat(6_000);
    let mut bounded = command.clone();
    bounded["variableValues"] = json!({(key.clone()): value.clone()});
    let decoded = serde_json::from_value::<ProductCommand>(bounded.clone())
        .expect("Bounded variables must deserialize.");
    assert_eq!(serde_json::to_value(decoded).unwrap(), bounded);
    for variables in [
        json!({(key.clone() + "x"): value.clone()}),
        json!({key: value + "x"}),
    ] {
        let mut payload = command.clone();
        payload["variableValues"] = variables;
        assert!(serde_json::from_value::<ProductCommand>(payload).is_err());
    }
}

#[test]
fn composer_integer_commands_accept_integral_json_numbers() {
    for payload in [
        r#"{"kind":"submit-message","sessionId":"session-1","prompt":"Build it","promptEnhancementMode":"off","interviewEnabled":false,"iterationCount":20.0}"#,
        r#"{"kind":"move-queued-message","sessionId":"session-1","messageId":"message-1","direction":-1.0}"#,
        r#"{"kind":"reorder-queued-message","sessionId":"session-1","messageId":"message-1","targetIndex":511.0}"#,
    ] {
        assert!(
            serde_json::from_str::<ProductCommand>(payload).is_ok(),
            "{payload}"
        );
    }
}
