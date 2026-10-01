use machdoch_fleet_protocol::{
    deserialize_host_message, serialize_host_message, GatewayPayloadBudgetError, HostMessage,
    HostResponse,
};
use serde_json::Value;

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
