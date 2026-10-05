use machdoch_fleet_protocol::{
    deserialize_host_message, serialize_host_message, GatewayPayloadBudgetError, HostMessage,
    HostResponse,
};
use serde_json::Value;

#[test]
fn telemetry_has_bounded_values_in_both_gateway_directions() {
    let mut payload: Value =
        serde_json::from_str(include_str!("../fixtures/desktop-snapshot.json")).unwrap();
    let telemetry = serde_json::json!({
        "capturedAt": 100, "platform": "linux", "architecture": "x64", "cpuCount": 8,
        "cpuUsagePercent": 12.5, "memoryTotalBytes": 1024, "memoryUsedBytes": 512,
        "uptimeSeconds": 100,
    });
    payload["response"]["snapshot"]["telemetry"] = telemetry.clone();
    let message = deserialize_host_message(serde_json::to_vec(&payload).unwrap()).unwrap();
    serialize_host_message(&message).unwrap();
    for memory in [
        serde_json::json!({"memoryTotalBytes": 1024.0, "memoryUsedBytes": 512}),
        serde_json::json!({"memoryTotalBytes": 1024.0, "memoryUsedBytes": 512.0}),
    ] {
        let mut valid_telemetry = telemetry.clone();
        valid_telemetry
            .as_object_mut()
            .unwrap()
            .extend(memory.as_object().unwrap().clone());
        payload["response"]["snapshot"]["telemetry"] = valid_telemetry;
        let message = deserialize_host_message(serde_json::to_vec(&payload).unwrap()).unwrap();
        serialize_host_message(&message).unwrap();
    }
    for invalid in [
        serde_json::json!({"cpuUsagePercent": 101}),
        serde_json::json!({"cpuCount": 0}),
        serde_json::json!({"memoryUsedBytes": 1025}),
        serde_json::json!({"memoryTotalBytes": 1024.0, "memoryUsedBytes": 1025.0}),
        serde_json::json!({"platform": "x".repeat(65)}),
        serde_json::json!({"architecture": ""}),
        serde_json::json!({"unknown": true}),
    ] {
        let mut invalid_telemetry = telemetry.clone();
        invalid_telemetry
            .as_object_mut()
            .unwrap()
            .extend(invalid.as_object().unwrap().clone());
        payload["response"]["snapshot"]["telemetry"] = invalid_telemetry;
        assert!(deserialize_host_message(serde_json::to_vec(&payload).unwrap()).is_err());
    }
}

#[test]
fn desktop_snapshot_is_valid_in_both_directions() {
    let payload = include_str!("../fixtures/desktop-snapshot.json");
    let message = deserialize_host_message(payload).expect("desktop snapshot must be valid");
    let encoded = serialize_host_message(&message).expect("desktop snapshot must serialize");
    assert_eq!(deserialize_host_message(encoded).unwrap(), message);
}

#[test]
fn invalid_outgoing_snapshot_is_rejected_before_transmission() {
    let mut payload: Value =
        serde_json::from_str(include_str!("../fixtures/desktop-snapshot.json")).unwrap();
    payload["response"]["snapshot"]["shell"]["composer"]
        .as_object_mut()
        .unwrap()
        .remove("sessionMemory");
    let message = HostMessage::Response {
        request_id: "request-1".to_string(),
        response: HostResponse::ProductSnapshot {
            snapshot: payload["response"]["snapshot"].clone(),
        },
    };
    assert!(
        matches!(serialize_host_message(&message), Err(GatewayPayloadBudgetError::Serialization(error)) if error.to_string().contains("Invalid product snapshot."))
    );
}
