use serde::Serialize;

use super::{
    now_millis, FleetCommandRecord, FleetControlInner, FleetShellSnapshot, FleetTaskSession,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetControlSnapshot {
    pub(super) enabled: bool,
    pub(super) server_time: u64,
    pub(super) event_id: u64,
    pub(super) sessions: Vec<FleetTaskSession>,
    pub(super) commands: Vec<FleetCommandRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) shell: Option<FleetShellSnapshot>,
}

pub(super) fn create_snapshot_locked(inner: &FleetControlInner) -> FleetControlSnapshot {
    FleetControlSnapshot {
        enabled: true,
        server_time: now_millis(),
        event_id: inner.event_id,
        sessions: sorted_sessions(inner),
        commands: inner.commands.iter().cloned().rev().collect(),
        shell: inner.shell.clone(),
    }
}

fn sorted_sessions(inner: &FleetControlInner) -> Vec<FleetTaskSession> {
    let mut sessions = inner.sessions.values().cloned().collect::<Vec<_>>();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_control::sanitize::sanitize_shell_snapshot;
    use machdoch_fleet_protocol::{
        deserialize_host_message, serialize_host_message, HostMessage, HostResponse,
    };

    #[test]
    fn desktop_shell_survives_the_rust_bridge_and_gateway_validation() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/fleet-protocol/fixtures/desktop-snapshot.json"
        ))
        .unwrap();
        let expected_shell = fixture["response"]["snapshot"]["shell"].clone();
        let shell = serde_json::from_value::<FleetShellSnapshot>(expected_shell.clone()).unwrap();
        let inner = FleetControlInner {
            shell: Some(sanitize_shell_snapshot(shell).unwrap()),
            ..FleetControlInner::default()
        };
        let snapshot = serde_json::to_value(create_snapshot_locked(&inner)).unwrap();
        assert_eq!(snapshot["shell"], expected_shell);
        let message = HostMessage::Response {
            request_id: "request-1".to_string(),
            response: HostResponse::ProductSnapshot { snapshot },
        };
        let encoded = serialize_host_message(&message).expect("desktop payload must be valid");
        assert_eq!(deserialize_host_message(encoded).unwrap(), message);
    }

    #[test]
    fn long_unicode_drafts_and_prompt_history_fit_the_protocol_limits() {
        let mut fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/fleet-protocol/fixtures/desktop-snapshot.json"
        ))
        .unwrap();
        let shell = &mut fixture["response"]["snapshot"]["shell"];
        shell["composer"]["draft"] = serde_json::json!("😀".repeat(8_000));
        shell["promptHistory"] = serde_json::json!(["😀".repeat(8_000)]);
        let sanitized =
            sanitize_shell_snapshot(serde_json::from_value(shell.clone()).unwrap()).unwrap();
        let inner = FleetControlInner {
            shell: Some(sanitized),
            ..FleetControlInner::default()
        };
        let snapshot = serde_json::to_value(create_snapshot_locked(&inner)).unwrap();
        assert_eq!(
            snapshot["shell"]["composer"]["draft"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count(),
            8_000
        );
        assert_eq!(
            snapshot["shell"]["promptHistory"][0]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count(),
            8_000
        );
        serialize_host_message(&HostMessage::Response {
            request_id: "request-1".to_string(),
            response: HostResponse::ProductSnapshot { snapshot },
        })
        .expect("sanitized Unicode content must be valid");
    }

    #[test]
    fn long_task_progress_remains_a_valid_gateway_snapshot() {
        let shared = crate::fleet_control::FleetControlShared {
            inner: std::sync::Mutex::new(FleetControlInner::default()),
        };
        let long_text = "😀".repeat(8_000);
        crate::fleet_control::state_progress::record_progress_update(
            &shared,
            "task-1",
            &serde_json::json!({
                "task": long_text,
                "message": long_text,
                "mode": long_text,
                "state": long_text,
                "actionOutput": { "chunk": long_text, "stream": long_text, "toolName": long_text },
                "timelineEvent": { "kind": long_text, "phase": long_text, "label": long_text, "tone": long_text, "toolName": long_text },
            }),
            1,
        );
        let snapshot =
            serde_json::to_value(create_snapshot_locked(&shared.inner.lock().unwrap())).unwrap();
        serialize_host_message(&HostMessage::Response {
            request_id: "request-1".to_string(),
            response: HostResponse::ProductSnapshot { snapshot },
        })
        .expect("bounded progress metadata must be valid");
    }
}
