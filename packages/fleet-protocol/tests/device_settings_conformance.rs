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
fn device_settings_requests_match_shared_conformance() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("../fixtures/device-settings-conformance.json")).unwrap();
    for fixture in corpus.cases {
        let request = json!({ "type": "deviceSettings", "request": fixture.request });
        assert_eq!(
            serde_json::from_value::<HostRequest>(request.clone()).is_ok(),
            fixture.accepted,
            "{}",
            fixture.name
        );
        let message = json!({ "type": "request", "requestId": "request-1", "request": request });
        assert_eq!(
            serde_json::from_value::<ManagerMessage>(message).is_ok(),
            fixture.accepted,
            "{}",
            fixture.name
        );
    }
}
