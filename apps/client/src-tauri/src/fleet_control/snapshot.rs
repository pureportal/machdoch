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
