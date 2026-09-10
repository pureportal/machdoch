use std::collections::BTreeSet;

use machdoch_fleet_protocol::{
    deserialize_host_message, FleetManagedSettingsDelivery, ProductCommand,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Corpus {
    version: u32,
    cases: Vec<Fixture>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Target {
    Command,
    ManagedSettings,
    Snapshot,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    id: String,
    target: Target,
    accepted: bool,
    payload: Value,
    gateway_bytes: Option<usize>,
}

fn expand_gateway_budget(payload: &mut Value, size: usize) {
    let empty_log = json!({"createdAt": 0, "stream": "stdout", "chunk": ""});
    let empty_bytes = serde_json::to_vec(&empty_log).unwrap().len();
    let entry_bytes = empty_bytes + 12_000 + 1;
    let remaining = size - serde_json::to_vec(payload).unwrap().len();
    let full_chunks = (remaining - empty_bytes) / entry_bytes;
    let logs = payload
        .pointer_mut("/response/snapshot/sessions/0/logs")
        .expect("budget fixture must contain session logs")
        .as_array_mut()
        .expect("logs must be an array");
    assert!(logs.is_empty());
    for _ in 0..full_chunks {
        logs.push(json!({"createdAt": 0, "stream": "stdout", "chunk": "x".repeat(12_000)}));
    }
    let final_length = remaining - full_chunks * entry_bytes - empty_bytes;
    assert!(final_length <= 12_000);
    logs.push(json!({"createdAt": 0, "stream": "stdout", "chunk": "x".repeat(final_length)}));
    assert_eq!(serde_json::to_vec(payload).unwrap().len(), size);
}

#[test]
fn shared_protocol_conformance() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("../fixtures/protocol-conformance.json"))
            .expect("shared corpus must have a valid schema");
    assert_eq!(corpus.version, 1);
    assert!(!corpus.cases.is_empty());
    let mut ids = BTreeSet::new();
    for fixture in &corpus.cases {
        assert!(!fixture.id.is_empty());
        assert!(ids.insert(&fixture.id), "duplicate fixture: {}", fixture.id);
    }

    let mut failures = Vec::new();
    for fixture in corpus.cases {
        let mut payload = fixture.payload;
        if let Some(size) = fixture.gateway_bytes {
            assert!(matches!(fixture.target, Target::Snapshot));
            expand_gateway_budget(&mut payload, size);
        }
        let result = match fixture.target {
            Target::Command => serde_json::from_value::<ProductCommand>(payload)
                .map(|_| ())
                .map_err(|error| error.to_string()),
            Target::ManagedSettings => {
                serde_json::from_value::<FleetManagedSettingsDelivery>(payload)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            }
            Target::Snapshot => deserialize_host_message(serde_json::to_vec(&payload).unwrap())
                .map(|_| ())
                .map_err(|error| error.to_string()),
        };
        println!(
            "CONFORMANCE {} {}",
            fixture.id,
            if result.is_ok() { "accept" } else { "reject" }
        );
        if result.is_ok() != fixture.accepted {
            failures.push(format!(
                "{}: expected accepted={}, got {result:?}",
                fixture.id, fixture.accepted
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
