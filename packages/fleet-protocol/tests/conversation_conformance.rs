use machdoch_fleet_protocol::HostResponse;
use serde_json::{json, Value};

#[test]
fn conversation_projections_conform_and_preserve_raw_whitespace() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../fixtures/conversation-conformance.json")).unwrap();
    let fixtures: Value = serde_json::from_str(include_str!("../fixtures/composer-conformance.json")).unwrap();
    for case in cases {
        let mut snapshot = fixtures["baseSnapshot"].clone();
        snapshot["shell"]["visibleMessages"] = json!([case["message"]]);
        let payload = json!({"type": "productSnapshot", "snapshot": snapshot});
        let decoded = serde_json::from_value::<HostResponse>(payload.clone());
        assert_eq!(decoded.is_ok(), case["accepted"].as_bool().unwrap(), "{}", case["name"]);
        if let Ok(value) = decoded {
            assert_eq!(serde_json::to_value(value).unwrap(), payload);
        }
    }
}

#[test]
fn conversation_prompt_projection_limits_count_utf16_units() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../fixtures/conversation-conformance.json")).unwrap();
    let fixtures: Value = serde_json::from_str(include_str!("../fixtures/composer-conformance.json")).unwrap();
    for field in ["rawContent", "originalPrompt"] {
        for (content, accepted) in [("🌿".repeat(6000), true), ("🌿".repeat(6000) + "x", false)] {
            let mut message = cases[0]["message"].clone();
            message[field] = Value::String(content);
            let mut snapshot = fixtures["baseSnapshot"].clone();
            snapshot["shell"]["visibleMessages"] = json!([message]);
            assert_eq!(serde_json::from_value::<HostResponse>(json!({"type": "productSnapshot", "snapshot": snapshot})).is_ok(), accepted, "{field}");
        }
    }
}
