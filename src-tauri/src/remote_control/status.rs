use serde::Serialize;

use super::{
    commands::RemoteCommandRecord, now_millis, RemoteControlInner, RemoteShellSnapshot,
    RemoteTaskSession,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlStatus {
    pub(super) enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) local_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) lan_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) display_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) qr_svg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) token_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) bind_address: Option<String>,
    pub(super) port: u16,
    pub(super) paired_device_count: usize,
    pub(super) event_id: u64,
    pub(super) sessions: Vec<RemoteTaskSession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteControlSnapshot {
    pub(super) enabled: bool,
    pub(super) server_time: u64,
    pub(super) event_id: u64,
    pub(super) sessions: Vec<RemoteTaskSession>,
    pub(super) commands: Vec<RemoteCommandRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) shell: Option<RemoteShellSnapshot>,
}

pub(super) fn create_status_locked(inner: &RemoteControlInner) -> RemoteControlStatus {
    let sessions = sorted_sessions(inner);

    match &inner.server {
        Some(server) => RemoteControlStatus {
            enabled: true,
            local_url: Some(server.local_url.clone()),
            lan_url: server.lan_url.clone(),
            display_url: Some(server.display_url.clone()),
            qr_svg: Some(server.qr_svg.clone()),
            token_hint: Some(create_token_hint(&server.token)),
            started_at: Some(server.started_at),
            bind_address: Some(server.bind_address.clone()),
            port: inner.config.port,
            paired_device_count: inner.config.paired_devices.len(),
            event_id: inner.event_id,
            sessions,
        },
        None => RemoteControlStatus {
            enabled: false,
            local_url: None,
            lan_url: None,
            display_url: None,
            qr_svg: None,
            token_hint: None,
            started_at: None,
            bind_address: None,
            port: inner.config.port,
            paired_device_count: inner.config.paired_devices.len(),
            event_id: inner.event_id,
            sessions,
        },
    }
}

pub(super) fn create_snapshot_locked(inner: &RemoteControlInner) -> RemoteControlSnapshot {
    RemoteControlSnapshot {
        enabled: inner.server.is_some(),
        server_time: now_millis(),
        event_id: inner.event_id,
        sessions: sorted_sessions(inner),
        commands: inner.commands.iter().cloned().rev().collect(),
        shell: inner.shell.clone(),
    }
}

fn sorted_sessions(inner: &RemoteControlInner) -> Vec<RemoteTaskSession> {
    let mut sessions = inner.sessions.values().cloned().collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions
}

pub(super) fn create_token_hint(token: &str) -> String {
    let suffix = token
        .chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();

    format!("...{suffix}")
}
