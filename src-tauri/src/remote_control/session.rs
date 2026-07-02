use std::sync::Arc;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::commands::truncate_chars;
use super::{
    auth::hash_remote_control_token,
    config::prune_expired_paired_devices_locked,
    config::write_remote_control_config_file,
    now_millis,
    pairing::{create_secure_token, refresh_server_pairing_url},
    RemoteControlPairedDevice, RemoteControlShared, MAX_PAIRED_DEVICES,
    REMOTE_CONTROL_CONFIG_VERSION, WEB_SESSION_TTL_MS,
};

pub(super) fn create_remote_web_session_token(
    shared: &Arc<RemoteControlShared>,
    user_agent: Option<&str>,
) -> Result<String, String> {
    let session_token = create_secure_token()?;
    let next_pairing_token = create_secure_token()?;
    let now = now_millis();
    let mut inner = shared
        .inner
        .lock()
        .map_err(|_| "Unable to create a Mission Control web session.".to_string())?;

    prune_expired_paired_devices_locked(&mut inner.config, now);
    remove_stale_paired_device_if_full(&mut inner.config.paired_devices);

    inner
        .config
        .paired_devices
        .push(create_paired_device(&session_token, user_agent, now));
    inner.config.version = REMOTE_CONTROL_CONFIG_VERSION;

    if let Some(server) = inner.server.as_mut() {
        refresh_server_pairing_url(server, next_pairing_token)?;
    }

    write_remote_control_config_file(&inner.config)?;
    inner.event_id = inner.event_id.saturating_add(1);
    shared.updates.notify_all();

    Ok(session_token)
}

fn remove_stale_paired_device_if_full(paired_devices: &mut Vec<RemoteControlPairedDevice>) {
    if paired_devices.len() < MAX_PAIRED_DEVICES {
        return;
    }

    let Some(stale_device_id) = paired_devices
        .iter()
        .min_by_key(|device| device.last_seen_at)
        .map(|device| device.id.clone())
    else {
        return;
    };

    paired_devices.retain(|device| device.id != stale_device_id);
}

fn create_paired_device(
    session_token: &str,
    user_agent: Option<&str>,
    now: u64,
) -> RemoteControlPairedDevice {
    RemoteControlPairedDevice {
        id: create_device_id(),
        name: create_device_name(user_agent),
        token_hash: hash_remote_control_token(session_token),
        created_at: now,
        last_seen_at: now,
        expires_at: now.saturating_add(WEB_SESSION_TTL_MS),
        user_agent: user_agent
            .map(|value| truncate_chars(value.trim(), 240))
            .filter(|value| !value.is_empty()),
    }
}

fn create_device_id() -> String {
    let mut bytes = [0_u8; 12];

    if getrandom::fill(&mut bytes).is_ok() {
        return URL_SAFE_NO_PAD.encode(bytes);
    }

    format!("device-{}", now_millis())
}

fn create_device_name(user_agent: Option<&str>) -> String {
    user_agent
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, 80))
        .unwrap_or_else(|| "Remote browser".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paired_device(id: &str, last_seen_at: u64) -> RemoteControlPairedDevice {
        RemoteControlPairedDevice {
            id: id.to_string(),
            name: id.to_string(),
            token_hash: format!("{id}-hash"),
            created_at: last_seen_at,
            last_seen_at,
            expires_at: last_seen_at + 1_000,
            user_agent: None,
        }
    }

    #[test]
    fn create_device_name_uses_trimmed_user_agent_or_default() {
        assert_eq!(
            create_device_name(Some("  Machdoch Browser  ")),
            "Machdoch Browser"
        );
        assert_eq!(create_device_name(Some("   ")), "Remote browser");
        assert_eq!(create_device_name(None), "Remote browser");
    }

    #[test]
    fn create_paired_device_hashes_token_and_truncates_user_agent() {
        let device = create_paired_device("session-token", Some("  Test Browser  "), 42);

        assert_eq!(device.name, "Test Browser");
        assert_eq!(
            device.token_hash,
            hash_remote_control_token("session-token")
        );
        assert_eq!(device.created_at, 42);
        assert_eq!(device.last_seen_at, 42);
        assert_eq!(device.expires_at, 42 + WEB_SESSION_TTL_MS);
        assert_eq!(device.user_agent.as_deref(), Some("Test Browser"));
    }

    #[test]
    fn remove_stale_paired_device_keeps_capacity_for_new_session() {
        let mut devices = (0..MAX_PAIRED_DEVICES)
            .map(|index| paired_device(&format!("device-{index}"), index as u64))
            .collect::<Vec<_>>();

        remove_stale_paired_device_if_full(&mut devices);

        assert_eq!(devices.len(), MAX_PAIRED_DEVICES - 1);
        assert!(devices.iter().all(|device| device.id != "device-0"));
    }

    #[test]
    fn remove_stale_paired_device_noops_below_capacity() {
        let mut devices = vec![paired_device("device-0", 0)];

        remove_stale_paired_device_if_full(&mut devices);

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "device-0");
    }
}
