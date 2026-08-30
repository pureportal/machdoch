use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::with_cooperative_file_lock,
    runtime_snapshot::get_user_config_directory,
};

pub(super) const FLEET_CONNECTION_SCHEMA_VERSION: u32 = 1;
const FLEET_CONNECTION_FILE_NAME: &str = "fleet-connection.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FleetConnectionConfig {
    pub(super) schema_version: u32,
    pub(super) enabled: bool,
    pub(super) manager_url: String,
    pub(super) manager_id: String,
    pub(super) instance_id: String,
    pub(super) display_name: String,
    pub(super) instance_secret: String,
}

pub(super) fn load_fleet_connection_config() -> Result<Option<FleetConnectionConfig>, String> {
    load_fleet_connection_config_at_path(&fleet_connection_path()?)
}

pub(super) fn write_fleet_connection_config(config: &FleetConnectionConfig) -> Result<(), String> {
    let path = fleet_connection_path()?;
    with_cooperative_file_lock(&path, || {
        write_fleet_connection_config_at_path(config, &path)
    })
}

pub(super) fn delete_fleet_connection_config() -> Result<(), String> {
    let path = fleet_connection_path()?;
    with_cooperative_file_lock(&path, || match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    })
}

pub(super) fn validate_fleet_manager_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim())
        .map_err(|error| format!("Fleet Manager URL is invalid: {error}"))?;
    let is_development_loopback_url = cfg!(debug_assertions)
        && url.scheme() == "http"
        && match url.host() {
            Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            Some(Host::Ipv4(address)) => address.is_loopback(),
            Some(Host::Ipv6(address)) => address.is_loopback(),
            None => false,
        };
    if url.scheme() != "https" && !is_development_loopback_url {
        return Err(if cfg!(debug_assertions) {
            "Fleet Manager URL must use HTTPS or a loopback HTTP origin in development.".to_string()
        } else {
            "Fleet Manager URL must use HTTPS.".to_string()
        });
    }
    if url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Fleet Manager URL must be an origin.".to_string());
    }
    Ok(url)
}

fn fleet_connection_path() -> Result<PathBuf, String> {
    Ok(get_user_config_directory()?.join(FLEET_CONNECTION_FILE_NAME))
}

fn load_fleet_connection_config_at_path(
    path: &Path,
) -> Result<Option<FleetConnectionConfig>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let config = serde_json::from_str::<FleetConnectionConfig>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
    validate_config(&config)?;
    Ok(Some(config))
}

fn write_fleet_connection_config_at_path(
    config: &FleetConnectionConfig,
    path: &Path,
) -> Result<(), String> {
    validate_config(config)?;
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Failed to create {}: {error}", directory.display()))?;
        secure_directory(directory)?;
    }
    let serialized = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize Fleet Manager connection: {error}"))?;
    write_file_atomic(
        path,
        format!("{serialized}\n").as_bytes(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    secure_file(path)
}

fn validate_config(config: &FleetConnectionConfig) -> Result<(), String> {
    if config.schema_version != FLEET_CONNECTION_SCHEMA_VERSION {
        return Err(format!(
            "Fleet connection schema version {FLEET_CONNECTION_SCHEMA_VERSION} is required."
        ));
    }
    validate_fleet_manager_url(&config.manager_url)?;
    if !super::valid_identifier(&config.manager_id, "manager")
        || !super::valid_identifier(&config.instance_id, "instance")
        || !super::valid_prefixed_secret(&config.instance_secret, "mch_instance")
    {
        return Err("Fleet connection identity is invalid.".to_string());
    }
    super::validate_display_name(&config.display_name)?;
    Ok(())
}

fn secure_directory(path: &Path) -> Result<(), String> {
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

fn secure_file(path: &Path) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn config() -> FleetConnectionConfig {
        FleetConnectionConfig {
            schema_version: 1,
            enabled: true,
            manager_url: "https://fleet.example.test".to_string(),
            manager_id: "manager_MDEyMzQ1Njc4OTAxMjM0NTY3".to_string(),
            instance_id: "instance_MDEyMzQ1Njc4OTAxMjM0NTY3".to_string(),
            display_name: "Workstation".to_string(),
            instance_secret: format!("mch_instance_{}", "A".repeat(43)),
        }
    }

    fn test_path() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("machdoch-fleet-config-{unique}"))
            .join(FLEET_CONNECTION_FILE_NAME)
    }

    #[test]
    fn config_round_trip_preserves_binding_and_secret() {
        let path = test_path();
        let config = config();
        write_fleet_connection_config_at_path(&config, &path).expect("config should write");
        let loaded = load_fleet_connection_config_at_path(&path)
            .expect("config should load")
            .expect("config should exist");

        assert_eq!(loaded.manager_id, config.manager_id);
        assert_eq!(loaded.instance_secret, config.instance_secret);

        fs::remove_dir_all(path.parent().expect("path should have a parent"))
            .expect("test directory should be removable");
    }

    #[test]
    fn manager_url_requires_a_secure_or_development_loopback_origin() {
        assert!(validate_fleet_manager_url("http://fleet.example.test").is_err());
        assert!(validate_fleet_manager_url("https://fleet.example.test/path").is_err());
        assert!(validate_fleet_manager_url("https://fleet.example.test").is_ok());
        if cfg!(debug_assertions) {
            assert!(validate_fleet_manager_url("http://127.0.0.1:43188").is_ok());
            assert!(validate_fleet_manager_url("http://localhost:43188").is_ok());
            assert!(validate_fleet_manager_url("http://[::1]:43188").is_ok());
        }
    }
}
