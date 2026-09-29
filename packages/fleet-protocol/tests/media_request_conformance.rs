use machdoch_fleet_protocol::{HostRequest, ManagerMessage};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Fixture>,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    accepted: bool,
    request: Value,
}

#[test]
fn media_requests_match_shared_conformance_cases() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("../fixtures/media-request-conformance.json"))
            .expect("media request fixtures should decode");
    for fixture in corpus.cases {
        let host_request = json!({ "type": "media", "request": fixture.request });
        let decoded = serde_json::from_value::<HostRequest>(host_request.clone());
        assert_eq!(decoded.is_ok(), fixture.accepted, "{}", fixture.name);
        if let Ok(HostRequest::Media { request }) = decoded {
            assert_eq!(request, host_request["request"], "{}", fixture.name);
        }
        let message = json!({
            "type": "request",
            "requestId": "request-1",
            "request": host_request,
        });
        assert_eq!(
            serde_json::from_value::<ManagerMessage>(message.clone()).is_ok(),
            fixture.accepted,
            "{}",
            fixture.name
        );
        let encoded = serde_json::to_vec(&message).expect("media request should encode");
        assert_eq!(
            serde_json::from_slice::<ManagerMessage>(&encoded).is_ok(),
            fixture.accepted,
            "{}",
            fixture.name
        );
    }
}
