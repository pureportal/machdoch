use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Manager;

mod config;
mod gateway;
mod settings;

pub use settings::FleetManagedSettingsDelivery;

use config::{
    delete_fleet_connection_config, load_fleet_connection_config, validate_fleet_manager_url,
    write_fleet_connection_config, FleetConnectionConfig,
};

#[derive(Clone, Default)]
pub struct FleetConnectionState {
    inner: Arc<Mutex<FleetConnectionInner>>,
}

#[derive(Default)]
struct FleetConnectionInner {
    generation: u64,
    config: Option<FleetConnectionConfig>,
    phase: FleetConnectionPhase,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum FleetConnectionPhase {
    #[default]
    Disabled,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetConnectionStatus {
    enabled: bool,
    phase: FleetConnectionPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    manager_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manager_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollmentResponse {
    manager_id: String,
    manager_url: String,
    instance_id: String,
}

struct FleetConnectionUpdate {
    gateway_config: Option<FleetConnectionConfig>,
    generation: u64,
}

type FleetConnectionObservation = Result<Option<FleetConnectionConfig>, String>;

pub fn initialize(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let state = app_handle.state::<FleetConnectionState>();
    let observation = load_fleet_connection_config();
    let initial_error = observation.as_ref().err().cloned();
    synchronize_connection_config(app_handle.clone(), state.inner.clone(), observation)?;
    spawn_config_monitor(app_handle.clone(), state.inner.clone());
    initial_error.map_or(Ok(()), Err)
}

#[tauri::command]
pub async fn get_fleet_connection_status(
    state: tauri::State<'_, FleetConnectionState>,
) -> Result<FleetConnectionStatus, String> {
    status(&state)
}

#[tauri::command]
pub async fn get_fleet_managed_settings(
    state: tauri::State<'_, FleetConnectionState>,
) -> Result<FleetManagedSettingsDelivery, String> {
    settings::fetch(&state).await
}

#[tauri::command]
pub async fn enroll_fleet_manager(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, FleetConnectionState>,
    manager_url: String,
    enrollment_key: String,
    display_name: String,
) -> Result<FleetConnectionStatus, String> {
    ensure_unbound(&state)?;
    if manager_url.len() > 2_048 {
        return Err("Fleet Manager URL is too long.".to_string());
    }
    let manager_url = validate_fleet_manager_url(&manager_url)?;
    let enrollment_key = enrollment_key.trim();
    if !valid_prefixed_secret(enrollment_key, "mch_enroll") {
        return Err("Enrollment key is invalid.".to_string());
    }
    let display_name = validate_display_name(&display_name)?;
    let instance_secret = create_secret("mch_instance")?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(format!("Machdoch/{}", app_handle.package_info().version))
        .build()
        .map_err(|error| format!("Unable to configure Fleet Manager client: {error}"))?;
    let endpoint = manager_url
        .join("/api/enroll")
        .map_err(|error| format!("Fleet Manager enrollment URL is invalid: {error}"))?;
    let response = client
        .post(endpoint)
        .bearer_auth(enrollment_key)
        .json(&serde_json::json!({
            "displayName": display_name,
            "instanceSecret": instance_secret,
            "productVersion": app_handle.package_info().version.to_string(),
            "protocolVersion": machdoch_fleet_protocol::GATEWAY_PROTOCOL_VERSION,
        }))
        .send()
        .await
        .map_err(|error| format!("Fleet Manager enrollment failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let message = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("Fleet Manager rejected enrollment ({status})."));
        return Err(message);
    }
    let enrollment = response
        .json::<EnrollmentResponse>()
        .await
        .map_err(|error| {
            format!("Fleet Manager returned an invalid enrollment response: {error}")
        })?;
    let returned_url = validate_fleet_manager_url(&enrollment.manager_url)?;
    let enrolled_manager_url = enrolled_manager_url(&manager_url, returned_url)?;
    if !valid_identifier(&enrollment.manager_id, "manager")
        || !valid_identifier(&enrollment.instance_id, "instance")
    {
        return Err(
            "Fleet Manager enrollment identity did not match the requested installation."
                .to_string(),
        );
    }
    let config = FleetConnectionConfig {
        schema_version: config::FLEET_CONNECTION_SCHEMA_VERSION,
        enabled: true,
        manager_url: enrolled_manager_url.origin().ascii_serialization(),
        manager_id: enrollment.manager_id,
        instance_id: enrollment.instance_id,
        display_name,
        instance_secret,
    };
    write_fleet_connection_config(&config)?;
    let generation = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
        inner.config = Some(config.clone());
        inner.phase = FleetConnectionPhase::Connecting;
        inner.last_error = None;
        inner.generation = inner.generation.saturating_add(1);
        inner.generation
    };
    spawn_gateway(app_handle, state.inner.clone(), config, generation);
    status(&state)
}

#[tauri::command]
pub async fn reset_fleet_manager_connection(
    state: tauri::State<'_, FleetConnectionState>,
) -> Result<FleetConnectionStatus, String> {
    delete_fleet_connection_config()?;
    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
        inner.generation = inner.generation.saturating_add(1);
        inner.config = None;
        inner.phase = FleetConnectionPhase::Disabled;
        inner.last_error = None;
    }
    status(&state)
}

fn ensure_unbound(state: &FleetConnectionState) -> Result<(), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    if inner.config.is_some() {
        return Err(
            "Reset the current Fleet Manager connection before enrolling again.".to_string(),
        );
    }
    Ok(())
}

fn status(state: &FleetConnectionState) -> Result<FleetConnectionStatus, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    let config = inner.config.as_ref();
    Ok(FleetConnectionStatus {
        enabled: config.is_some_and(|config| config.enabled),
        phase: inner.phase,
        manager_url: config.map(|config| config.manager_url.clone()),
        manager_id: config.map(|config| config.manager_id.clone()),
        instance_id: config.map(|config| config.instance_id.clone()),
        display_name: config.map(|config| config.display_name.clone()),
        last_error: inner.last_error.clone(),
    })
}

fn spawn_gateway(
    app_handle: tauri::AppHandle,
    state: Arc<Mutex<FleetConnectionInner>>,
    config: FleetConnectionConfig,
    generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        gateway::run(app_handle, state, config, generation).await;
    });
}

fn spawn_config_monitor(app_handle: tauri::AppHandle, state: Arc<Mutex<FleetConnectionInner>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if let Err(error) = synchronize_connection_config(
                app_handle.clone(),
                state.clone(),
                load_fleet_connection_config(),
            ) {
                eprintln!("Failed to synchronize Fleet connection configuration: {error}");
                return;
            }
        }
    });
}

fn synchronize_connection_config(
    app_handle: tauri::AppHandle,
    state: Arc<Mutex<FleetConnectionInner>>,
    observation: FleetConnectionObservation,
) -> Result<(), String> {
    let update = {
        let mut inner = state
            .lock()
            .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
        update_connection_inner(&mut inner, observation)
    };
    if let Some(FleetConnectionUpdate {
        gateway_config: Some(config),
        generation,
    }) = update
    {
        spawn_gateway(app_handle, state, config, generation);
    }
    Ok(())
}

fn update_connection_inner(
    inner: &mut FleetConnectionInner,
    observation: FleetConnectionObservation,
) -> Option<FleetConnectionUpdate> {
    let unchanged = match &observation {
        Ok(config) => {
            inner.config == *config
                && (config.as_ref().is_some_and(|config| config.enabled)
                    || inner.phase == FleetConnectionPhase::Disabled)
        }
        Err(error) => {
            inner.config.is_none()
                && inner.phase == FleetConnectionPhase::Error
                && inner.last_error.as_ref() == Some(error)
        }
    };
    if unchanged {
        return None;
    }

    inner.generation = inner.generation.saturating_add(1);
    match observation {
        Ok(config) => {
            let gateway_config = config.clone().filter(|config| config.enabled);
            inner.config = config;
            inner.phase = if gateway_config.is_some() {
                FleetConnectionPhase::Connecting
            } else {
                FleetConnectionPhase::Disabled
            };
            inner.last_error = None;
            Some(FleetConnectionUpdate {
                gateway_config,
                generation: inner.generation,
            })
        }
        Err(error) => {
            inner.config = None;
            inner.phase = FleetConnectionPhase::Error;
            inner.last_error = Some(error);
            Some(FleetConnectionUpdate {
                gateway_config: None,
                generation: inner.generation,
            })
        }
    }
}

fn enrolled_manager_url(
    requested_url: &url::Url,
    returned_url: url::Url,
) -> Result<url::Url, String> {
    if returned_url.origin() == requested_url.origin() {
        return Ok(returned_url);
    }
    if cfg!(debug_assertions) && requested_url.scheme() == "http" {
        return Ok(requested_url.clone());
    }
    Err("Fleet Manager enrollment identity did not match the requested installation.".to_string())
}

fn validate_display_name(value: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.chars().count() > 80
        || normalized.chars().any(char::is_control)
    {
        return Err("Instance name must contain between 1 and 80 characters.".to_string());
    }
    Ok(normalized.to_string())
}

fn valid_prefixed_secret(value: &str, prefix: &str) -> bool {
    let Some(encoded) = value.strip_prefix(&format!("{prefix}_")) else {
        return false;
    };
    base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, encoded)
        .is_ok_and(|bytes| bytes.len() == 32)
}

fn valid_identifier(value: &str, prefix: &str) -> bool {
    let Some(encoded) = value.strip_prefix(&format!("{prefix}_")) else {
        return false;
    };
    base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, encoded)
        .is_ok_and(|bytes| bytes.len() == 18)
}

fn create_secret(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Unable to generate instance credentials: {error}"))?;
    Ok(format!(
        "{prefix}_{}",
        base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_status_omits_credentials_and_binding_fields() {
        let status = FleetConnectionStatus {
            enabled: false,
            phase: FleetConnectionPhase::Disabled,
            manager_url: None,
            manager_id: None,
            instance_id: None,
            display_name: None,
            last_error: None,
        };
        let value = serde_json::to_value(status).expect("status should serialize");

        assert_eq!(
            value,
            serde_json::json!({ "enabled": false, "phase": "disabled" })
        );
    }

    #[test]
    fn enrolled_manager_url_only_uses_requested_http_origin_in_development() {
        let requested_url = url::Url::parse("http://127.0.0.1:43188").expect("URL should parse");
        let returned_url = url::Url::parse("https://fleet.example.test").expect("URL should parse");
        let result = enrolled_manager_url(&requested_url, returned_url);

        assert_eq!(result.is_ok(), cfg!(debug_assertions));
        if cfg!(debug_assertions) {
            assert_eq!(
                result.expect("development URL should resolve").as_str(),
                "http://127.0.0.1:43188/"
            );
        }
    }

    #[test]
    fn enrolled_manager_url_preserves_matching_https_origin() {
        let requested_url =
            url::Url::parse("https://fleet.example.test").expect("URL should parse");
        let returned_url = requested_url.clone();

        assert_eq!(
            enrolled_manager_url(&requested_url, returned_url)
                .expect("matching URL should resolve")
                .as_str(),
            "https://fleet.example.test/"
        );
    }

    #[test]
    fn config_observations_enable_disable_and_recover_from_errors() {
        let mut inner = FleetConnectionInner::default();
        let config = FleetConnectionConfig {
            schema_version: config::FLEET_CONNECTION_SCHEMA_VERSION,
            enabled: true,
            manager_url: "https://fleet.example.test".to_string(),
            manager_id: "manager_MDEyMzQ1Njc4OTAxMjM0NTY3".to_string(),
            instance_id: "instance_MDEyMzQ1Njc4OTAxMjM0NTY3".to_string(),
            display_name: "Workstation".to_string(),
            instance_secret: format!("mch_instance_{}", "A".repeat(43)),
        };

        let enabled = update_connection_inner(&mut inner, Ok(Some(config.clone())))
            .expect("enabling should update state");
        assert!(enabled.gateway_config.is_some());
        assert_eq!(inner.phase, FleetConnectionPhase::Connecting);
        assert!(update_connection_inner(&mut inner, Ok(Some(config.clone()))).is_none());

        let disabled_config = FleetConnectionConfig {
            enabled: false,
            ..config
        };
        let disabled = update_connection_inner(&mut inner, Ok(Some(disabled_config)))
            .expect("disabling should update state");
        assert!(disabled.gateway_config.is_none());
        assert_eq!(inner.phase, FleetConnectionPhase::Disabled);

        update_connection_inner(&mut inner, Err("invalid config".to_string()))
            .expect("invalid configuration should update state");
        assert_eq!(inner.phase, FleetConnectionPhase::Error);
        assert_eq!(inner.last_error.as_deref(), Some("invalid config"));

        update_connection_inner(&mut inner, Ok(None))
            .expect("removing invalid configuration should recover state");
        assert_eq!(inner.phase, FleetConnectionPhase::Disabled);
        assert!(inner.last_error.is_none());
    }
}
