use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use machdoch_fleet_protocol::FleetManagedSettingsDelivery;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::{Host, Url};

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::with_cooperative_file_lock,
    runtime_snapshot::get_user_config_directory,
};

pub(super) const FLEET_CONNECTION_SCHEMA_VERSION: u32 = 1;
const FLEET_CONNECTION_FILE_NAME: &str = "fleet-connection.json";
const MANAGED_SETTINGS_CACHE_FILE_NAME: &str = "fleet-managed-settings.json";

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

/// Removes the connection together with its cached delivery, whose managed
/// secrets can never apply to another enrollment.
pub(super) fn delete_fleet_connection_config() -> Result<(), String> {
    delete_fleet_connection_at(&CachePaths::current()?)
}

fn delete_fleet_connection_at(paths: &CachePaths) -> Result<(), String> {
    with_cooperative_file_lock(&paths.connection, || {
        remove_file_if_present(&paths.connection)?;
        remove_file_if_present(&paths.cache)
    })
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    }
}

pub(super) fn validate_cloud_server_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim())
        .map_err(|error| format!("machdoch.cloud URL is invalid: {error}"))?;
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
            "machdoch.cloud URL must use HTTPS or a loopback HTTP origin in development.".to_string()
        } else {
            "machdoch.cloud URL must use HTTPS.".to_string()
        });
    }
    if url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("machdoch.cloud URL must be an origin.".to_string());
    }
    Ok(url)
}

fn fleet_connection_path() -> Result<PathBuf, String> {
    Ok(get_user_config_directory()?.join(FLEET_CONNECTION_FILE_NAME))
}

/// The connection file doubles as the lock that serializes cache updates
/// with enrollment changes, for the CLI runtime as well.
struct CachePaths {
    connection: PathBuf,
    cache: PathBuf,
}

impl CachePaths {
    fn current() -> Result<Self, String> {
        let directory = get_user_config_directory()?;
        Ok(Self {
            connection: directory.join(FLEET_CONNECTION_FILE_NAME),
            cache: directory.join(MANAGED_SETTINGS_CACHE_FILE_NAME),
        })
    }
}

/// Identifies the enrollment a cached delivery belongs to. The CLI computes
/// the same digest over `JSON.stringify([url, manager, instance, secret, enabled])`.
pub(super) fn connection_digest(config: &FleetConnectionConfig) -> String {
    let manager_url = Url::parse(config.manager_url.trim())
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| config.manager_url.clone());
    let tuple = serde_json::to_string(&(
        manager_url,
        &config.manager_id,
        &config.instance_id,
        &config.instance_secret,
        config.enabled,
    ))
    .unwrap_or_default();
    Sha256::digest(tuple.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedSettingsCache {
    connection_digest: String,
    delivery: FleetManagedSettingsDelivery,
}

/// Persists the last validated delivery where the CLI runtime reads its overlay.
pub(super) fn write_managed_settings_cache(
    config: &FleetConnectionConfig,
    delivery: &FleetManagedSettingsDelivery,
) -> Result<(), String> {
    write_managed_settings_cache_at(&CachePaths::current()?, config, delivery)
}

fn write_managed_settings_cache_at(
    paths: &CachePaths,
    config: &FleetConnectionConfig,
    delivery: &FleetManagedSettingsDelivery,
) -> Result<(), String> {
    let path = &paths.cache;
    with_cooperative_file_lock(&paths.connection, || {
        if load_fleet_connection_config_at_path(&paths.connection)?.as_ref() != Some(config) {
            return Err("machdoch.cloud connection changed during synchronization.".to_string());
        }
        if let Some(directory) = path.parent() {
            fs::create_dir_all(directory)
                .map_err(|error| format!("Failed to create {}: {error}", directory.display()))?;
            secure_directory(directory)?;
        }
        let serialized = serde_json::to_vec(&ManagedSettingsCache {
            connection_digest: connection_digest(config),
            delivery: delivery.clone(),
        })
        .map_err(|error| format!("Failed to serialize managed settings: {error}"))?;
        write_file_atomic(path, &serialized, AtomicWriteOptions::with_unix_mode(0o600))
            .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
        secure_file(path)
    })
}

/// Removes the cached delivery after machdoch.cloud rejected `config`'s
/// credentials, unless the device was enrolled again in the meantime.
pub(super) fn discard_managed_settings_cache(config: &FleetConnectionConfig) -> Result<(), String> {
    discard_managed_settings_cache_at(&CachePaths::current()?, config)
}

fn discard_managed_settings_cache_at(
    paths: &CachePaths,
    config: &FleetConnectionConfig,
) -> Result<(), String> {
    with_cooperative_file_lock(&paths.connection, || {
        if load_fleet_connection_config_at_path(&paths.connection)?.as_ref() != Some(config) {
            return Ok(());
        }
        remove_file_if_present(&paths.cache)
    })
}

/// Reads the cached delivery for the current enabled connection, if any.
pub(super) fn load_managed_settings_cache(
) -> Result<Option<FleetManagedSettingsDelivery>, String> {
    match load_fleet_connection_config()?.filter(|config| config.enabled) {
        Some(config) => read_managed_settings_cache(&config),
        None => Ok(None),
    }
}

/// Reads the cached delivery if it belongs to `config`.
pub(super) fn read_managed_settings_cache(
    config: &FleetConnectionConfig,
) -> Result<Option<FleetManagedSettingsDelivery>, String> {
    read_managed_settings_cache_at(&CachePaths::current()?.cache, config)
}

fn read_managed_settings_cache_at(
    path: &Path,
    config: &FleetConnectionConfig,
) -> Result<Option<FleetManagedSettingsDelivery>, String> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    if raw.len() > machdoch_fleet_protocol::MAX_MANAGED_SETTINGS_DELIVERY_BYTES + 1024 {
        return Err("Cached Fleet settings exceed the size limit.".to_string());
    }
    let cache = serde_json::from_slice::<ManagedSettingsCache>(&raw)
        .map_err(|_| "Cached Fleet settings are invalid.".to_string())?;
    if cache.connection_digest != connection_digest(config)
        || cache.delivery.manager_id != config.manager_id
    {
        return Ok(None);
    }
    Ok(Some(cache.delivery))
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
        .map_err(|error| format!("Failed to serialize machdoch.cloud connection: {error}"))?;
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
    validate_cloud_server_url(&config.manager_url)?;
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
    fn connection_digest_matches_the_cli_cache_digest() {
        let config = FleetConnectionConfig {
            instance_secret: "mch_instance_AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM".to_string(),
            ..config()
        };
        // sha256(JSON.stringify([managerUrl, managerId, instanceId, instanceSecret, enabled]))
        assert_eq!(
            connection_digest(&config),
            "393cc8e896db8c774251e963eb88ed6fb1a9dd41b121727445ecdd785ef5fad3"
        );
        assert_ne!(
            connection_digest(&FleetConnectionConfig {
                enabled: false,
                ..config.clone()
            }),
            connection_digest(&config)
        );
    }

    #[test]
    fn managed_settings_cache_round_trips_with_the_cli_shape() {
        let cache = ManagedSettingsCache {
            connection_digest: connection_digest(&config()),
            delivery: serde_json::from_value(serde_json::json!({
                "schemaVersion": 3,
                "managerId": "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
                "profile": null
            }))
            .expect("delivery should parse"),
        };
        let encoded = serde_json::to_value(&cache).expect("cache should encode");
        assert_eq!(
            encoded["connectionDigest"],
            serde_json::Value::String(connection_digest(&config()))
        );
        assert!(encoded["delivery"].get("layers").is_none());
        let decoded: ManagedSettingsCache =
            serde_json::from_value(encoded).expect("cache should decode");
        assert_eq!(decoded.delivery.schema_version, 3);
    }

    #[test]
    fn managed_settings_cache_belongs_to_the_connection_that_wrote_it() {
        let connection = test_path();
        let paths = CachePaths {
            cache: connection.with_file_name(MANAGED_SETTINGS_CACHE_FILE_NAME),
            connection,
        };
        let config = config();
        let delivery: FleetManagedSettingsDelivery = serde_json::from_value(serde_json::json!({
            "schemaVersion": 3,
            "managerId": "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
            "profile": null
        }))
        .expect("delivery should parse");
        write_fleet_connection_config_at_path(&config, &paths.connection)
            .expect("config should write");
        write_managed_settings_cache_at(&paths, &config, &delivery).expect("cache should write");
        assert_eq!(
            read_managed_settings_cache_at(&paths.cache, &config).expect("cache should read"),
            Some(delivery.clone())
        );

        let reenrolled = FleetConnectionConfig {
            instance_secret: format!("mch_instance_{}E", "A".repeat(42)),
            ..config.clone()
        };
        assert_eq!(
            read_managed_settings_cache_at(&paths.cache, &reenrolled).expect("cache should read"),
            None
        );
        // A rejection that arrives for another enrollment keeps the current cache.
        discard_managed_settings_cache_at(&paths, &reenrolled).expect("discard should finish");
        assert!(paths.cache.exists());
        discard_managed_settings_cache_at(&paths, &config).expect("discard should finish");
        assert!(!paths.cache.exists());

        write_managed_settings_cache_at(&paths, &config, &delivery).expect("cache should write");
        fs::write(&paths.cache, b"{broken").expect("cache should be replaceable");
        assert!(read_managed_settings_cache_at(&paths.cache, &config).is_err());
        delete_fleet_connection_at(&paths).expect("connection should be removed");
        assert!(!paths.cache.exists() && !paths.connection.exists());
        assert!(write_managed_settings_cache_at(&paths, &config, &delivery).is_err());

        fs::remove_dir_all(
            paths
                .connection
                .parent()
                .expect("path should have a parent"),
        )
        .expect("test directory should be removable");
    }

    #[test]
    fn manager_url_requires_a_secure_or_development_loopback_origin() {
        assert!(validate_cloud_server_url("http://fleet.example.test").is_err());
        assert!(validate_cloud_server_url("https://fleet.example.test/path").is_err());
        assert!(validate_cloud_server_url("https://fleet.example.test").is_ok());
        if cfg!(debug_assertions) {
            assert!(validate_cloud_server_url("http://127.0.0.1:43188").is_ok());
            assert!(validate_cloud_server_url("http://localhost:43188").is_ok());
            assert!(validate_cloud_server_url("http://[::1]:43188").is_ok());
        }
    }
}
