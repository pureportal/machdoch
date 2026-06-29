use std::{
    fs,
    net::{Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::runtime_snapshot::get_user_config_directory;

use super::{
    now_millis, RemoteControlConfigFile, DEFAULT_REMOTE_CONTROL_PORT, MAX_PAIRED_DEVICES,
    MIN_REMOTE_CONTROL_PORT, REMOTE_CONTROL_CONFIG_FILE_NAME, REMOTE_CONTROL_CONFIG_VERSION,
};

pub(super) fn default_remote_control_config_version() -> u32 {
    REMOTE_CONTROL_CONFIG_VERSION
}

pub(super) fn default_remote_control_port() -> u16 {
    DEFAULT_REMOTE_CONTROL_PORT
}

pub(super) fn validate_remote_control_port(port: u16) -> Result<u16, String> {
    if port < MIN_REMOTE_CONTROL_PORT {
        return Err(format!(
            "Mission Control port must be between {MIN_REMOTE_CONTROL_PORT} and 65535."
        ));
    }

    Ok(port)
}

pub(super) fn ensure_remote_control_port_available(port: u16) -> Result<(), String> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
        .map(|_| ())
        .map_err(|error| format!("Mission Control port {port} is not available: {error}"))
}

fn remote_control_config_path() -> Result<PathBuf, String> {
    Ok(get_user_config_directory()?.join(REMOTE_CONTROL_CONFIG_FILE_NAME))
}

pub(super) fn load_remote_control_config_file() -> Result<RemoteControlConfigFile, String> {
    let config_path = remote_control_config_path()?;

    if !config_path.exists() {
        return Ok(RemoteControlConfigFile::default());
    }

    let raw = fs::read_to_string(&config_path)
        .map_err(|error| format!("Failed to read {}: {error}", config_path.display()))?;
    let parsed = serde_json::from_str::<RemoteControlConfigFile>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", config_path.display()))?;

    Ok(normalize_remote_control_config(parsed))
}

fn normalize_remote_control_config(mut config: RemoteControlConfigFile) -> RemoteControlConfigFile {
    config.version = REMOTE_CONTROL_CONFIG_VERSION;

    if validate_remote_control_port(config.port).is_err() {
        config.port = DEFAULT_REMOTE_CONTROL_PORT;
    }

    let now = now_millis();
    config.paired_devices.retain(|device| {
        !device.id.trim().is_empty()
            && !device.token_hash.trim().is_empty()
            && device.expires_at > now
    });
    config
        .paired_devices
        .sort_by(|left, right| right.last_seen_at.cmp(&left.last_seen_at));
    config.paired_devices.truncate(MAX_PAIRED_DEVICES);

    config
}

pub(super) fn write_remote_control_config_file(
    config: &RemoteControlConfigFile,
) -> Result<(), String> {
    let config_path = remote_control_config_path()?;

    if let Some(config_directory) = config_path.parent() {
        fs::create_dir_all(config_directory)
            .map_err(|error| format!("Failed to create {}: {error}", config_directory.display()))?;
        secure_remote_control_config_directory(config_directory)?;
    }

    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize Mission Control settings: {error}"))?;
    fs::write(&config_path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))?;
    secure_remote_control_config_file(&config_path)
}

fn secure_remote_control_config_directory(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }

    Ok(())
}

fn secure_remote_control_config_file(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }

    Ok(())
}

pub(super) fn prune_expired_paired_devices_locked(config: &mut RemoteControlConfigFile, now: u64) {
    config
        .paired_devices
        .retain(|device| device.expires_at > now);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_control::RemoteControlPairedDevice;

    #[test]
    fn normalize_config_resets_invalid_port_and_keeps_recent_devices_first() {
        let now = now_millis();
        let mut config = RemoteControlConfigFile {
            version: 0,
            port: 12,
            enabled: true,
            paired_devices: vec![
                RemoteControlPairedDevice {
                    id: "older".to_string(),
                    name: "Older".to_string(),
                    token_hash: "old-token".to_string(),
                    created_at: now - 20,
                    last_seen_at: now - 10,
                    expires_at: now + 1_000,
                    user_agent: None,
                },
                RemoteControlPairedDevice {
                    id: "expired".to_string(),
                    name: "Expired".to_string(),
                    token_hash: "expired-token".to_string(),
                    created_at: now - 30,
                    last_seen_at: now,
                    expires_at: now - 1,
                    user_agent: None,
                },
                RemoteControlPairedDevice {
                    id: "newer".to_string(),
                    name: "Newer".to_string(),
                    token_hash: "new-token".to_string(),
                    created_at: now - 10,
                    last_seen_at: now,
                    expires_at: now + 1_000,
                    user_agent: None,
                },
                RemoteControlPairedDevice {
                    id: " ".to_string(),
                    name: "Blank".to_string(),
                    token_hash: "blank-token".to_string(),
                    created_at: now,
                    last_seen_at: now,
                    expires_at: now + 1_000,
                    user_agent: None,
                },
            ],
        };

        config = normalize_remote_control_config(config);

        assert_eq!(config.version, REMOTE_CONTROL_CONFIG_VERSION);
        assert_eq!(config.port, DEFAULT_REMOTE_CONTROL_PORT);
        assert_eq!(
            config
                .paired_devices
                .iter()
                .map(|device| device.id.as_str())
                .collect::<Vec<_>>(),
            vec!["newer", "older"]
        );
    }

    #[test]
    fn validate_port_rejects_reserved_range() {
        assert!(validate_remote_control_port(MIN_REMOTE_CONTROL_PORT - 1).is_err());
        assert_eq!(
            validate_remote_control_port(MIN_REMOTE_CONTROL_PORT),
            Ok(MIN_REMOTE_CONTROL_PORT)
        );
    }
}
