use std::sync::OnceLock;

use machdoch_fleet_protocol::{
    FleetManagedSettingsDelivery, FleetManagedSettingsDocument,
    FleetManagedSettingsLayerIdentity, FleetManagedSettingsSyncReport,
    LEGACY_MANAGED_SETTINGS_SCHEMA_VERSION, MANAGED_SETTINGS_SCHEMA_VERSION,
    MAX_MANAGED_SETTINGS_DELIVERY_BYTES,
};
use reqwest::{header, StatusCode};

use super::{
    config::{
        discard_managed_settings_cache, read_managed_settings_cache, validate_cloud_server_url,
        write_managed_settings_cache, FleetConnectionConfig,
    },
    http::{
        is_unsafe_text_character, manager_response_error, read_bounded_response, ResponseBodyError,
    },
    now_seconds, valid_identifier, FleetConnectionState, FleetSettingsSyncPhase,
    FleetSettingsSyncStatus,
};

pub async fn capture_enrollment(
    state: &FleetConnectionState,
    manager_id: &str,
    instance_id: &str,
    document: FleetManagedSettingsDocument,
) -> Result<(), String> {
    let (response, _) =
        put_device_settings(state, manager_id, instance_id, document, "/enrollment").await?;
    if !response.status().is_success() {
        return Err(
            manager_response_error(response, "machdoch.cloud rejected device settings").await,
        );
    }
    Ok(())
}

pub async fn enrollment_capture_required(state: &FleetConnectionState) -> Result<bool, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct CaptureStatus {
        capture_required: bool,
    }
    let (config, generation) = connected_config(state)?;
    let response = send_settings_request(
        state,
        &config,
        generation,
        settings_client()?.get(settings_endpoint(&config, "/enrollment")?),
        "Device settings status is unavailable",
    )
    .await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err("Update machdoch.cloud to capture device settings.".to_string());
    }
    if !response.status().is_success() {
        return Err(
            manager_response_error(response, "machdoch.cloud rejected device settings").await,
        );
    }
    let body = read_bounded_response(response, 1024)
        .await
        .map_err(settings_response_error)?;
    let status: CaptureStatus = serde_json::from_slice(&body)
        .map_err(|_| "machdoch.cloud returned invalid device settings status.".to_string())?;
    require_current_generation(state, generation)?;
    Ok(status.capture_required)
}

pub async fn fetch(
    state: &FleetConnectionState,
    known_etag: Option<&str>,
) -> Result<Option<FleetManagedSettingsDelivery>, String> {
    let (config, generation) = connected_config(state)?;
    mark_sync_started(state, generation)?;
    // A 304 only helps while the cache still holds that delivery: the CLI runtime
    // and the API key overlay read it, so a missing or replaced cache is refetched.
    let known_etag = known_etag.filter(|etag| {
        read_managed_settings_cache(&config)
            .ok()
            .flatten()
            .is_some_and(|cached| managed_settings_etag(&cached) == *etag)
    });
    let result = match fetch_delivery(state, &config, generation, known_etag).await {
        Ok(Some(delivery)) => require_current_generation(state, generation)
            .and_then(|()| write_managed_settings_cache(&config, &delivery))
            .map(|()| Some(delivery)),
        other => other,
    };
    match result {
        Ok(delivery) => {
            if let Some(delivery) = &delivery {
                update_sync_target(state, generation, delivery)?;
            } else {
                require_current_generation(state, generation)?;
            }
            Ok(delivery)
        }
        Err(error) => {
            let _ = mark_sync_failed(state, generation, &error);
            Err(error)
        }
    }
}

async fn fetch_delivery(
    state: &FleetConnectionState,
    config: &FleetConnectionConfig,
    generation: u64,
    known_etag: Option<&str>,
) -> Result<Option<FleetManagedSettingsDelivery>, String> {
    let mut endpoint = settings_endpoint(config, "")?;
    endpoint.set_query(Some(&format!(
        "schemaVersion={MANAGED_SETTINGS_SCHEMA_VERSION}"
    )));
    let mut request = settings_client()?.get(endpoint);
    if let Some(etag) = known_etag {
        if etag.len() > 512 {
            return Err("Fleet settings entity tag is invalid.".to_string());
        }
        let value = header::HeaderValue::from_str(etag)
            .map_err(|_| "Fleet settings entity tag is invalid.".to_string())?;
        request = request.header(header::IF_NONE_MATCH, value);
    }
    let response = send_settings_request(
        state,
        config,
        generation,
        request,
        "Fleet settings synchronization failed",
    )
    .await?;
    if response.status() == StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(manager_response_error(
            response,
            "machdoch.cloud rejected settings synchronization",
        )
        .await);
    }
    let body = read_bounded_response(response, MAX_MANAGED_SETTINGS_DELIVERY_BYTES)
        .await
        .map_err(settings_response_error)?;
    parse_delivery(&body, &config.manager_id).map(Some)
}

/// Mirrors `createFleetManagedSettingsEtag` from the protocol package.
fn managed_settings_etag(delivery: &FleetManagedSettingsDelivery) -> String {
    let manager_id = &delivery.manager_id;
    if delivery.schema_version < MANAGED_SETTINGS_SCHEMA_VERSION {
        return match &delivery.profile {
            Some(profile) => format!(
                "\"managed-settings.{manager_id}.{}.{}\"",
                profile.profile_id, profile.revision
            ),
            None => format!("\"managed-settings.{manager_id}.unassigned\""),
        };
    }
    let layers = match (&delivery.profile, &delivery.layers) {
        (None, _) => Vec::new(),
        (Some(_), Some(layers)) if !layers.is_empty() => layers
            .iter()
            .map(|layer| format!("{}.{}", layer.profile_id, layer.revision))
            .collect(),
        (Some(profile), _) => vec![format!("{}.{}", profile.profile_id, profile.revision)],
    };
    if layers.is_empty() {
        format!("\"managed-settings.v3.{manager_id}.unassigned\"")
    } else {
        format!("\"managed-settings.v3.{manager_id}.{}\"", layers.join("+"))
    }
}

pub async fn report_applied(
    state: &FleetConnectionState,
    manager_id: &str,
    profile_id: Option<&str>,
    revision: Option<u64>,
    layers: Option<Vec<FleetManagedSettingsLayerIdentity>>,
    warnings: Vec<String>,
) -> Result<(), String> {
    if (profile_id.is_none()) != (revision.is_none()) {
        return Err("Applied Fleet settings identity is invalid.".to_string());
    }
    let (config, generation) = connected_config(state)?;
    if manager_id != config.manager_id {
        return Err("machdoch.cloud identity changed before settings were applied.".to_string());
    }
    let warnings = normalize_sync_warnings(warnings);
    let layers = validate_report_layers(layers, profile_id)?;
    // Clouds that delivered schema version 2 reject the newer report fields.
    let current = reports_current_schema(state, generation)?;
    let report = FleetManagedSettingsSyncReport::Applied {
        manager_id: manager_id.to_string(),
        profile_id: profile_id.map(str::to_string),
        revision,
        layers: layers.filter(|_| current),
        warnings: (current && !warnings.is_empty()).then(|| warnings.clone()),
    };
    match send_report(state, &config, generation, &report).await {
        Ok(()) => mark_sync_applied(state, generation, profile_id, revision, warnings),
        Err(error) => {
            let _ = mark_sync_failed(state, generation, &error);
            Err(error)
        }
    }
}

pub async fn report_failure(
    state: &FleetConnectionState,
    manager_id: &str,
    profile_id: Option<&str>,
    revision: Option<u64>,
    error: &str,
    layers: Option<Vec<FleetManagedSettingsLayerIdentity>>,
) -> Result<(), String> {
    if (profile_id.is_none()) != (revision.is_none()) {
        return Err("Failed Fleet settings identity is invalid.".to_string());
    }
    let (config, generation) = connected_config(state)?;
    if manager_id != config.manager_id {
        return Err("machdoch.cloud identity changed during settings synchronization.".to_string());
    }
    let error = normalize_sync_error(error);
    let layers = validate_report_layers(layers, profile_id)?;
    let current = reports_current_schema(state, generation)?;
    mark_sync_failed(state, generation, &error)?;
    send_report(
        state,
        &config,
        generation,
        &FleetManagedSettingsSyncReport::Failed {
            manager_id: manager_id.to_string(),
            profile_id: profile_id.map(str::to_string),
            revision,
            error,
            layers: layers.filter(|_| current),
        },
    )
    .await
}

fn validate_report_layers(
    layers: Option<Vec<FleetManagedSettingsLayerIdentity>>,
    profile_id: Option<&str>,
) -> Result<Option<Vec<FleetManagedSettingsLayerIdentity>>, String> {
    let Some(layers) = layers.filter(|layers| !layers.is_empty()) else {
        return Ok(None);
    };
    let mut ids = std::collections::BTreeSet::new();
    if layers.len() > machdoch_fleet_protocol::MAX_MANAGED_SETTINGS_LAYERS
        || layers.first().map(|layer| layer.profile_id.as_str()) != profile_id
        || layers.iter().any(|layer| {
            !valid_identifier(&layer.profile_id, "profile")
                || layer.revision == 0
                || !ids.insert(layer.profile_id.clone())
        })
    {
        return Err("Applied Fleet settings layers are invalid.".to_string());
    }
    Ok(Some(layers))
}

fn normalize_sync_warnings(warnings: Vec<String>) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for warning in warnings {
        let cleaned = safe_report_text(&warning, 500);
        if !cleaned.is_empty() && !normalized.contains(&cleaned) {
            normalized.push(cleaned);
        }
        if normalized.len() == 32 {
            break;
        }
    }
    normalized
}

/// Replaces control and formatting characters, then trims and bounds the text.
fn safe_report_text(value: &str, maximum_characters: usize) -> String {
    let cleaned = value
        .chars()
        .map(|character| {
            if is_unsafe_text_character(character) {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    cleaned.trim().chars().take(maximum_characters).collect()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetSnapshotStatus {
    pub requested: bool,
    pub captured_at: Option<f64>,
}

/// Returns `None` when machdoch.cloud predates device settings snapshots.
pub async fn snapshot_status(
    state: &FleetConnectionState,
) -> Result<Option<FleetSnapshotStatus>, String> {
    let (config, generation) = connected_config(state)?;
    let response = send_settings_request(
        state,
        &config,
        generation,
        settings_client()?.get(settings_endpoint(&config, "/snapshot")?),
        "Device settings status is unavailable",
    )
    .await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(
            manager_response_error(response, "machdoch.cloud rejected device settings").await,
        );
    }
    let body = read_bounded_response(response, 1024)
        .await
        .map_err(settings_response_error)?;
    let status: FleetSnapshotStatus = serde_json::from_slice(&body)
        .map_err(|_| "machdoch.cloud returned invalid device settings status.".to_string())?;
    if status
        .captured_at
        .is_some_and(|value| !value.is_finite() || value < 0.0)
    {
        return Err("machdoch.cloud returned invalid device settings status.".to_string());
    }
    mark_snapshot_captured(state, generation, status.captured_at)?;
    Ok(Some(status))
}

/// Uploads the device baseline. Returns false when machdoch.cloud predates snapshots.
pub async fn upload_snapshot(
    state: &FleetConnectionState,
    manager_id: &str,
    instance_id: &str,
    document: FleetManagedSettingsDocument,
) -> Result<bool, String> {
    let (response, generation) =
        put_device_settings(state, manager_id, instance_id, document, "/snapshot").await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(
            manager_response_error(response, "machdoch.cloud rejected device settings").await,
        );
    }
    mark_snapshot_captured(state, generation, Some(now_seconds() as f64))?;
    Ok(true)
}

/// Sends the device baseline to the snapshot or the legacy enrollment endpoint.
async fn put_device_settings(
    state: &FleetConnectionState,
    manager_id: &str,
    instance_id: &str,
    document: FleetManagedSettingsDocument,
    suffix: &str,
) -> Result<(reqwest::Response, u64), String> {
    let (config, generation) = connected_config(state)?;
    if config.manager_id != manager_id || config.instance_id != instance_id {
        return Err(
            "machdoch.cloud connection changed before device settings were captured.".to_string(),
        );
    }
    let body = serde_json::to_vec(&document)
        .map_err(|error| format!("Device settings could not be read: {error}"))?;
    if body.len() > MAX_MANAGED_SETTINGS_DELIVERY_BYTES {
        return Err("Device settings exceed the size limit.".to_string());
    }
    let response = send_settings_request(
        state,
        &config,
        generation,
        settings_client()?
            .put(settings_endpoint(&config, suffix)?)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body),
        "Device settings could not be uploaded",
    )
    .await?;
    Ok((response, generation))
}

const PROPOSAL_KINDS: [&str; 4] = ["instruction", "contextPack", "prompt", "mcpServer"];
const MAX_PROPOSAL_BYTES: usize = 512 * 1024;

/// Sends one local item for an administrator to review; returns the proposal id.
pub async fn propose(
    state: &FleetConnectionState,
    manager_id: &str,
    instance_id: &str,
    proposal: serde_json::Value,
) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ProposalShape {
        kind: String,
        item: serde_json::Map<String, serde_json::Value>,
        #[serde(default)]
        note: Option<String>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProposalResponse {
        proposal_id: String,
    }
    let (config, generation) = connected_config(state)?;
    if config.manager_id != manager_id || config.instance_id != instance_id {
        return Err("machdoch.cloud connection changed before the proposal was sent.".to_string());
    }
    let shape: ProposalShape = serde_json::from_value(proposal.clone())
        .map_err(|_| "The proposed setting is invalid.".to_string())?;
    if !PROPOSAL_KINDS.contains(&shape.kind.as_str())
        || shape.item.is_empty()
        || shape.note.as_deref().is_some_and(|note| {
            note.chars().count() > 500 || note.chars().any(char::is_control)
        })
    {
        return Err("The proposed setting is invalid.".to_string());
    }
    let body = serde_json::to_vec(&proposal)
        .map_err(|error| format!("The proposal could not be encoded: {error}"))?;
    if body.len() > MAX_PROPOSAL_BYTES {
        return Err("The proposed setting exceeds the size limit.".to_string());
    }
    let response = send_settings_request(
        state,
        &config,
        generation,
        settings_client()?
            .post(settings_endpoint(&config, "/proposals")?)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body),
        "The proposal could not be sent",
    )
    .await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err("Update machdoch.cloud to propose settings.".to_string());
    }
    if !response.status().is_success() {
        return Err(manager_response_error(response, "machdoch.cloud rejected the proposal").await);
    }
    let body = read_bounded_response(response, 4096)
        .await
        .map_err(settings_response_error)?;
    let parsed: ProposalResponse = serde_json::from_slice(&body)
        .map_err(|_| "machdoch.cloud returned an invalid proposal response.".to_string())?;
    if parsed.proposal_id.is_empty() || parsed.proposal_id.len() > 240 {
        return Err("machdoch.cloud returned an invalid proposal response.".to_string());
    }
    Ok(parsed.proposal_id)
}

async fn send_report(
    state: &FleetConnectionState,
    config: &FleetConnectionConfig,
    generation: u64,
    report: &FleetManagedSettingsSyncReport,
) -> Result<(), String> {
    let response = send_settings_request(
        state,
        config,
        generation,
        settings_client()?
            .put(settings_endpoint(config, "/sync-status")?)
            .json(report),
        "Fleet settings status report failed",
    )
    .await?;
    if response.status().is_success() {
        return Ok(());
    }
    Err(manager_response_error(
        response,
        "machdoch.cloud rejected the settings status report",
    )
    .await)
}

/// Sends an authenticated settings request for the connection of `generation`.
/// Rejected credentials also discard the cached delivery, so its managed
/// secrets stop applying.
async fn send_settings_request(
    state: &FleetConnectionState,
    config: &FleetConnectionConfig,
    generation: u64,
    request: reqwest::RequestBuilder,
    failure: &str,
) -> Result<reqwest::Response, String> {
    let response = request
        .bearer_auth(&config.instance_secret)
        .send()
        .await
        .map_err(|error| format!("{failure}: {error}"))?;
    require_current_generation(state, generation)?;
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        let _ = discard_managed_settings_cache(config);
    }
    Ok(response)
}

fn connected_config(
    state: &FleetConnectionState,
) -> Result<(FleetConnectionConfig, u64), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    let config = inner
        .config
        .clone()
        .filter(|config| config.enabled)
        .ok_or_else(|| "machdoch.cloud is not connected.".to_string())?;
    Ok((config, inner.generation))
}

fn settings_endpoint(
    config: &FleetConnectionConfig,
    suffix: &str,
) -> Result<url::Url, String> {
    validate_cloud_server_url(&config.manager_url)?
        .join(&format!(
            "/api/client/settings/{}{}",
            config.instance_id, suffix
        ))
        .map_err(|error| format!("Fleet settings URL is invalid: {error}"))
}

fn settings_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|error| format!("Unable to configure Fleet settings client: {error}"))
        })
        .clone()
}

fn mark_sync_started(state: &FleetConnectionState, generation: u64) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    require_generation(&inner, generation)?;
    let previous = inner.settings_sync.take();
    inner.settings_sync = Some(FleetSettingsSyncStatus {
        phase: FleetSettingsSyncPhase::Syncing,
        profile_id: previous
            .as_ref()
            .and_then(|status| status.profile_id.clone()),
        profile_name: previous
            .as_ref()
            .and_then(|status| status.profile_name.clone()),
        revision: previous.as_ref().and_then(|status| status.revision),
        layers: previous.as_ref().and_then(|status| status.layers.clone()),
        warnings: previous
            .as_ref()
            .map(|status| status.warnings.clone())
            .unwrap_or_default(),
        snapshot_captured_at: previous.as_ref().and_then(|status| status.snapshot_captured_at),
        schema_version: previous.as_ref().and_then(|status| status.schema_version),
        last_attempt_at: now_seconds(),
        last_applied_at: previous.and_then(|status| status.last_applied_at),
        last_error: None,
    });
    Ok(())
}

fn update_sync_target(
    state: &FleetConnectionState,
    generation: u64,
    delivery: &FleetManagedSettingsDelivery,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    require_generation(&inner, generation)?;
    let status = inner
        .settings_sync
        .as_mut()
        .ok_or_else(|| "Fleet settings synchronization state is unavailable.".to_string())?;
    if let Some(profile) = &delivery.profile {
        status.profile_id = Some(profile.profile_id.clone());
        status.profile_name = Some(profile.name.clone());
        status.revision = Some(profile.revision);
    } else {
        status.profile_id = None;
        status.profile_name = None;
        status.revision = None;
    }
    status.layers = delivery.layers.clone();
    status.schema_version = Some(delivery.schema_version);
    Ok(())
}

/// Whether the last delivery came from a cloud that accepts layered reports
/// with warnings; anything else gets the legacy report body.
fn reports_current_schema(state: &FleetConnectionState, generation: u64) -> Result<bool, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    require_generation(&inner, generation)?;
    Ok(inner
        .settings_sync
        .as_ref()
        .and_then(|status| status.schema_version)
        == Some(MANAGED_SETTINGS_SCHEMA_VERSION))
}

fn mark_sync_applied(
    state: &FleetConnectionState,
    generation: u64,
    profile_id: Option<&str>,
    revision: Option<u64>,
    warnings: Vec<String>,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    require_generation(&inner, generation)?;
    let now = now_seconds();
    let status = inner.settings_sync.get_or_insert(FleetSettingsSyncStatus {
        phase: FleetSettingsSyncPhase::Applied,
        profile_id: None,
        profile_name: None,
        revision: None,
        layers: None,
        warnings: Vec::new(),
        snapshot_captured_at: None,
        schema_version: None,
        last_attempt_at: now,
        last_applied_at: None,
        last_error: None,
    });
    if status.profile_id.as_deref() != profile_id {
        status.profile_name = None;
        status.layers = None;
    }
    status.warnings = warnings;
    status.phase = FleetSettingsSyncPhase::Applied;
    status.profile_id = profile_id.map(str::to_string);
    status.revision = revision;
    status.last_applied_at = Some(now);
    status.last_error = None;
    Ok(())
}

fn mark_sync_failed(
    state: &FleetConnectionState,
    generation: u64,
    error: &str,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    require_generation(&inner, generation)?;
    let now = now_seconds();
    let status = inner.settings_sync.get_or_insert(FleetSettingsSyncStatus {
        phase: FleetSettingsSyncPhase::Error,
        profile_id: None,
        profile_name: None,
        revision: None,
        layers: None,
        warnings: Vec::new(),
        snapshot_captured_at: None,
        schema_version: None,
        last_attempt_at: now,
        last_applied_at: None,
        last_error: None,
    });
    status.phase = FleetSettingsSyncPhase::Error;
    status.last_attempt_at = now;
    status.last_error = Some(normalize_sync_error(error));
    Ok(())
}

fn mark_snapshot_captured(
    state: &FleetConnectionState,
    generation: u64,
    captured_at: Option<f64>,
) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    require_generation(&inner, generation)?;
    if let Some(status) = inner.settings_sync.as_mut() {
        status.snapshot_captured_at = captured_at.map(|value| value as u64);
    }
    Ok(())
}

fn normalize_sync_error(error: &str) -> String {
    let normalized = safe_report_text(error, 1_000);
    if normalized.is_empty() {
        return "Fleet settings synchronization failed.".to_string();
    }
    normalized
}

fn require_current_generation(state: &FleetConnectionState, generation: u64) -> Result<(), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    require_generation(&inner, generation)
}

fn require_generation(inner: &super::FleetConnectionInner, generation: u64) -> Result<(), String> {
    if inner.generation != generation {
        return Err("machdoch.cloud connection changed during synchronization.".to_string());
    }
    Ok(())
}

fn settings_response_error(error: ResponseBodyError) -> String {
    match error {
        ResponseBodyError::TooLarge => {
            "Fleet settings response exceeded the size limit.".to_string()
        }
        ResponseBodyError::Read(error) => {
            format!("Fleet settings response could not be read: {error}")
        }
    }
}

fn parse_delivery(
    body: &[u8],
    expected_manager_id: &str,
) -> Result<FleetManagedSettingsDelivery, String> {
    if body.len() > MAX_MANAGED_SETTINGS_DELIVERY_BYTES {
        return Err("Fleet settings response exceeded the size limit.".to_string());
    }
    let delivery = serde_json::from_slice::<FleetManagedSettingsDelivery>(body)
        .map_err(|error| format!("machdoch.cloud returned invalid settings: {error}"))?;
    if delivery.schema_version != MANAGED_SETTINGS_SCHEMA_VERSION
        && delivery.schema_version != LEGACY_MANAGED_SETTINGS_SCHEMA_VERSION
    {
        return Err("machdoch.cloud returned an unsupported settings schema.".to_string());
    }
    if delivery.manager_id != expected_manager_id
        || !valid_identifier(&delivery.manager_id, "manager")
    {
        return Err("machdoch.cloud returned settings for another installation.".to_string());
    }
    if let Some(profile) = &delivery.profile {
        if profile.revision == 0
            || !valid_identifier(&profile.profile_id, "profile")
            || profile.name.trim().is_empty()
        {
            return Err(
                "machdoch.cloud returned inconsistent settings assignment data.".to_string(),
            );
        }
    }
    Ok(delivery)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANAGER_ID: &str = "manager_MDEyMzQ1Njc4OTAxMjM0NTY3";

    fn connected_state(manager_url: String) -> FleetConnectionState {
        let state = FleetConnectionState::default();
        state.inner.lock().expect("state should lock").config =
            Some(super::super::config::FleetConnectionConfig {
                schema_version: 1,
                enabled: true,
                manager_url,
                manager_id: MANAGER_ID.to_string(),
                instance_id: "instance_MDEyMzQ1Njc4OTAxMjM0NTY3".to_string(),
                display_name: "Fixture".to_string(),
                instance_secret: "fixture-secret".to_string(),
            });
        state
    }

    const PROFILE_ID: &str = "profile_MDEyMzQ1Njc4OTAxMjM0NTY3";
    const TEAM_PROFILE_ID: &str = "profile_MDEyMzQ1Njc4OTAxMjM0NTY4";

    fn delivery(schema_version: u8, assigned: bool, layered: bool) -> FleetManagedSettingsDelivery {
        let mut value = serde_json::json!({
            "schemaVersion": schema_version,
            "managerId": MANAGER_ID,
            "profile": null
        });
        if assigned {
            value["profile"] = serde_json::json!({
                "profileId": PROFILE_ID,
                "name": "Baseline",
                "revision": 2,
                "document": {
                    "defaults": {"provider": null, "model": null, "mode": null, "reasoning": null, "webSearchProvider": null, "theme": null, "density": null, "accent": null},
                    "agentLimits": {"infinite": null, "executorTurns": null, "autopilotExecutorIterations": null},
                    "instructions": [], "contextPacks": [], "prompts": []
                },
                "secrets": {}
            });
        }
        if layered {
            value["layers"] = serde_json::json!([
                {"profileId": PROFILE_ID, "name": "Baseline", "revision": 2},
                {"profileId": TEAM_PROFILE_ID, "name": "Team", "revision": 5}
            ]);
        }
        serde_json::from_value(value).expect("fixture delivery should parse")
    }

    #[test]
    fn entity_tags_match_the_protocol_package() {
        for (delivery, expected) in [
            (
                delivery(2, true, false),
                "\"managed-settings.manager_MDEyMzQ1Njc4OTAxMjM0NTY3.profile_MDEyMzQ1Njc4OTAxMjM0NTY3.2\"",
            ),
            (
                delivery(2, false, false),
                "\"managed-settings.manager_MDEyMzQ1Njc4OTAxMjM0NTY3.unassigned\"",
            ),
            (
                delivery(3, true, true),
                "\"managed-settings.v3.manager_MDEyMzQ1Njc4OTAxMjM0NTY3.profile_MDEyMzQ1Njc4OTAxMjM0NTY3.2+profile_MDEyMzQ1Njc4OTAxMjM0NTY4.5\"",
            ),
            (
                delivery(3, true, false),
                "\"managed-settings.v3.manager_MDEyMzQ1Njc4OTAxMjM0NTY3.profile_MDEyMzQ1Njc4OTAxMjM0NTY3.2\"",
            ),
            (
                delivery(3, false, false),
                "\"managed-settings.v3.manager_MDEyMzQ1Njc4OTAxMjM0NTY3.unassigned\"",
            ),
        ] {
            assert_eq!(managed_settings_etag(&delivery), expected);
        }
    }

    #[tokio::test]
    async fn reports_use_the_body_the_delivering_cloud_accepts() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture server should bind");
        let address = listener.local_addr().expect("fixture address should exist");
        let server = tokio::spawn(async move {
            let mut bodies = Vec::new();
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().await.expect("client should connect");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                let body_start = loop {
                    let count = stream.read(&mut buffer).await.expect("request should read");
                    assert!(count > 0 && request.len() < 65_536);
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(index) = request.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let head = String::from_utf8_lossy(&request[..body_start]).to_ascii_lowercase();
                assert!(head.starts_with(
                    "put /api/client/settings/instance_mdeymzq1njc4otaxmjm0nty3/sync-status "
                ));
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .expect("report should declare its length");
                while request.len() < body_start + length {
                    let count = stream.read(&mut buffer).await.expect("body should read");
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                bodies.push(
                    serde_json::from_slice::<serde_json::Value>(&request[body_start..])
                        .expect("report should be JSON"),
                );
                stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                    .await
                    .expect("response should write");
            }
            bodies
        });
        let state = connected_state(format!("http://{address}"));
        let layers = vec![
            FleetManagedSettingsLayerIdentity {
                profile_id: PROFILE_ID.to_string(),
                revision: 2,
            },
            FleetManagedSettingsLayerIdentity {
                profile_id: TEAM_PROFILE_ID.to_string(),
                revision: 5,
            },
        ];
        let warnings = vec!["MCP server \"Docs\" stays off.".to_string()];
        mark_sync_started(&state, 0).expect("sync should start");
        update_sync_target(&state, 0, &delivery(2, true, false)).expect("target should update");
        report_applied(
            &state,
            MANAGER_ID,
            Some(PROFILE_ID),
            Some(2),
            None,
            warnings.clone(),
        )
        .await
        .expect("legacy report should send");
        mark_sync_started(&state, 0).expect("sync should start");
        update_sync_target(&state, 0, &delivery(3, true, true)).expect("target should update");
        report_applied(
            &state,
            MANAGER_ID,
            Some(PROFILE_ID),
            Some(2),
            Some(layers.clone()),
            warnings.clone(),
        )
        .await
        .expect("layered report should send");
        report_failure(
            &state,
            MANAGER_ID,
            Some(PROFILE_ID),
            Some(2),
            "Write\nfailed.",
            Some(layers),
        )
        .await
        .expect("failure report should send");
        let bodies = server.await.expect("fixture server should finish");

        assert_eq!(
            bodies[0],
            serde_json::json!({"status": "applied", "managerId": MANAGER_ID, "profileId": PROFILE_ID, "revision": 2})
        );
        assert_eq!(bodies[1]["layers"][1]["profileId"], TEAM_PROFILE_ID);
        assert_eq!(bodies[1]["warnings"], serde_json::json!(warnings));
        assert_eq!(bodies[2]["error"], "Write failed.");
        assert_eq!(bodies[2]["layers"].as_array().map(Vec::len), Some(2));
        let inner = state.inner.lock().expect("state should lock");
        assert_eq!(
            inner
                .settings_sync
                .as_ref()
                .map(|status| status.warnings.clone()),
            Some(warnings)
        );
    }

    #[tokio::test]
    async fn enrollment_capture_rejects_changed_identity_before_sending() {
        let state = connected_state("https://unreachable.example.test".to_string());
        let document: FleetManagedSettingsDocument = serde_json::from_value(serde_json::json!({
            "defaults": {"provider": null, "model": null, "mode": null, "reasoning": null, "webSearchProvider": null, "theme": null, "density": null, "accent": null},
            "agentLimits": {"infinite": null, "executorTurns": null, "autopilotExecutorIterations": null},
            "instructions": [], "contextPacks": [], "prompts": []
        })).expect("fixture document should parse");
        for (manager_id, instance_id) in [
            ("manager_changed", "instance_MDEyMzQ1Njc4OTAxMjM0NTY3"),
            (MANAGER_ID, "instance_changed"),
        ] {
            let error = capture_enrollment(&state, manager_id, instance_id, document.clone())
                .await
                .expect_err("changed identity should fail");
            assert_eq!(
                error,
                "machdoch.cloud connection changed before device settings were captured."
            );
        }
    }

    #[tokio::test]
    async fn enrollment_status_requires_authenticated_bounded_schema_response() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (body, expected_length, valid) in [
            (r#"{"captureRequired":false}"#, 25, true),
            (r#"{"captureRequired":false,"extra":true}"#, 38, false),
            (r#"{"captureRequired":false}"#, 2048, false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("fixture server should bind");
            let address = listener.local_addr().expect("fixture address should exist");
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.expect("client should connect");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                while !request.windows(4).any(|chunk| chunk == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).await.expect("request should read");
                    assert!(count > 0 && request.len() < 8192);
                    request.extend_from_slice(&buffer[..count]);
                }
                let request = String::from_utf8(request).expect("request should be text");
                assert!(request.starts_with(
                    "GET /api/client/settings/instance_MDEyMzQ1Njc4OTAxMjM0NTY3/enrollment "
                ));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer fixture-secret\r\n"));
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {expected_length}\r\nConnection: close\r\n\r\n{body}").as_bytes()).await.expect("response should write");
            });
            let result =
                enrollment_capture_required(&connected_state(format!("http://{address}"))).await;
            server.await.expect("fixture server should finish");
            if valid {
                assert_eq!(result.expect("valid status should parse"), false);
            } else {
                assert!(result.is_err());
            }
        }
    }

    #[test]
    fn parses_unassigned_delivery() {
        let delivery = parse_delivery(
            br#"{"schemaVersion":2,"managerId":"manager_MDEyMzQ1Njc4OTAxMjM0NTY3","profile":null}"#,
            MANAGER_ID,
        )
        .expect("delivery should parse");

        assert!(delivery.profile.is_none());
    }

    #[test]
    fn parses_layered_v3_delivery_and_validates_reported_layers() {
        let delivery = parse_delivery(
            br#"{
                "schemaVersion": 3,
                "managerId": "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
                "profile": {
                    "profileId": "profile_MDEyMzQ1Njc4OTAxMjM0NTY3",
                    "name": "Baseline + Team",
                    "revision": 2,
                    "document": {
                        "defaults": {"provider": null, "model": null, "mode": null, "reasoning": null, "webSearchProvider": null, "theme": "dark", "density": null, "accent": null},
                        "agentLimits": {"infinite": null, "executorTurns": null, "autopilotExecutorIterations": null},
                        "instructions": [], "contextPacks": [], "prompts": [],
                        "policy": {"enforced": ["theme"]},
                        "mcpServers": []
                    },
                    "secrets": {"mcp_github_token": "secret"}
                },
                "layers": [
                    {"profileId": "profile_MDEyMzQ1Njc4OTAxMjM0NTY3", "name": "Baseline", "revision": 2},
                    {"profileId": "profile_MDEyMzQ1Njc4OTAxMjM0NTY4", "name": "Team", "revision": 5}
                ]
            }"#,
            MANAGER_ID,
        )
        .expect("v3 delivery should parse");
        let layers = delivery.layers.expect("layers should exist");
        assert_eq!(layers.len(), 2);
        let identities = layers
            .iter()
            .map(|layer| FleetManagedSettingsLayerIdentity {
                profile_id: layer.profile_id.clone(),
                revision: layer.revision,
            })
            .collect::<Vec<_>>();
        assert!(validate_report_layers(
            Some(identities.clone()),
            Some("profile_MDEyMzQ1Njc4OTAxMjM0NTY3")
        )
        .is_ok());
        assert!(validate_report_layers(
            Some(identities),
            Some("profile_MDEyMzQ1Njc4OTAxMjM0NTY4")
        )
        .is_err());
        assert_eq!(validate_report_layers(Some(Vec::new()), None), Ok(None));
    }

    #[test]
    fn managed_secret_overlay_keeps_own_keys_unless_enforced() {
        let overlay = super::super::ManagedSecretOverlay {
            defaults: [
                ("openai".to_string(), "company-default".to_string()),
                ("tavily".to_string(), "company-search".to_string()),
            ]
            .into(),
            enforced: [("anthropic".to_string(), "company-enforced".to_string())].into(),
        };
        let merged = overlay.apply(
            [
                ("openai".to_string(), "own-openai".to_string()),
                ("anthropic".to_string(), "own-anthropic".to_string()),
            ]
            .into(),
            |id| id != "tavily",
        );
        assert_eq!(merged.get("openai").map(String::as_str), Some("own-openai"));
        assert_eq!(
            merged.get("anthropic").map(String::as_str),
            Some("company-enforced")
        );
        assert!(!merged.contains_key("tavily"));
    }

    #[test]
    fn rejects_delivery_from_another_manager() {
        let result = parse_delivery(
            br#"{
                "schemaVersion": 2,
                "managerId": "manager_MDEyMzQ1Njc4OTAxMjM0NTY4",
                "profile": null
            }"#,
            MANAGER_ID,
        );

        assert!(result.is_err());
    }

    #[test]
    fn parses_complete_managed_settings_document() {
        let delivery = parse_delivery(
            br#"{
                "schemaVersion": 2,
                "managerId": "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
                "profile": {
                    "profileId": "profile_MDEyMzQ1Njc4OTAxMjM0NTY3",
                    "name": "Engineering",
                    "revision": 3,
                    "document": {
                        "defaults": {
                            "provider": "openai",
                            "model": "gpt-5.6",
                            "mode": "machdoch",
                            "reasoning": "high",
                            "webSearchProvider": "tavily",
                            "theme": "dark",
                            "density": "compact",
                            "accent": "sky"
                        },
                        "agentLimits": {
                            "infinite": false,
                            "executorTurns": 20,
                            "autopilotExecutorIterations": 10
                        },
                        "instructions": [],
                        "contextPacks": [{
                            "id": "123e4567-e89b-42d3-a456-426614174000",
                            "name": "Review",
                            "instructions": "Review carefully.",
                            "prompt": "Review this change.",
                            "provider": "openai",
                            "model": "gpt-5.6",
                            "mode": "ask",
                            "reasoning": "medium",
                            "variables": [{"name": "target", "defaultValue": "src"}],
                            "triggerPhrases": ["review"],
                            "pathPatterns": ["src/**"],
                            "promptEnhancementMode": "web-search",
                            "interviewEnabled": true,
                            "sessionMemoryEnabled": false,
                            "useGlobalMemory": true,
                            "uiControlEnabled": false
                        }],
                        "prompts": [{
                            "id": "123e4567-e89b-42d3-a456-426614174001",
                            "relativePath": "review.prompt.md",
                            "content": "Review this change."
                        }]
                    },
                    "secrets": {"openai": "secret"}
                }
            }"#,
            MANAGER_ID,
        )
        .expect("delivery should parse");

        assert_eq!(delivery.profile.expect("profile should exist").revision, 3);
    }

    #[test]
    fn local_sync_status_tracks_failures_and_recovery() {
        let state = FleetConnectionState::default();
        mark_sync_started(&state, 0).expect("sync should start");
        update_sync_target(
            &state,
            0,
            &FleetManagedSettingsDelivery {
                schema_version: MANAGED_SETTINGS_SCHEMA_VERSION,
                manager_id: MANAGER_ID.to_string(),
                profile: None,
                layers: None,
            },
        )
        .expect("target should update");
        mark_sync_failed(&state, 0, "  Prompt write failed.  ")
            .expect("failure should be recorded");

        {
            let inner = state.inner.lock().expect("state should lock");
            let status = inner.settings_sync.as_ref().expect("status should exist");
            assert_eq!(status.phase, FleetSettingsSyncPhase::Error);
            assert_eq!(status.last_error.as_deref(), Some("Prompt write failed."));
        }

        mark_sync_applied(
            &state,
            0,
            None,
            None,
            normalize_sync_warnings(vec![
                " Prompt review.prompt.md replaces your local copy. ".to_string(),
                " Prompt review.prompt.md replaces your local copy. ".to_string(),
                "\u{7}".to_string(),
            ]),
        )
        .expect("sync should recover");
        let inner = state.inner.lock().expect("state should lock");
        let status = inner.settings_sync.as_ref().expect("status should exist");
        assert_eq!(status.phase, FleetSettingsSyncPhase::Applied);
        assert!(status.last_applied_at.is_some());
        assert!(status.last_error.is_none());
        assert_eq!(
            status.warnings,
            vec!["Prompt review.prompt.md replaces your local copy.".to_string()]
        );
    }

    #[test]
    fn sync_errors_are_bounded_on_unicode_boundaries() {
        let error = format!("{}tail", "🙂".repeat(1_000));
        let normalized = normalize_sync_error(&error);

        assert_eq!(normalized.chars().count(), 1_000);
        assert!(normalized.chars().all(|character| character == '🙂'));
    }

    #[test]
    fn stale_synchronization_cannot_update_replaced_connection_state() {
        let state = FleetConnectionState::default();
        mark_sync_started(&state, 0).expect("sync should start");
        state.inner.lock().expect("state should lock").generation = 1;

        assert!(mark_sync_failed(&state, 0, "stale failure").is_err());
        let inner = state.inner.lock().expect("state should lock");
        assert_eq!(
            inner
                .settings_sync
                .as_ref()
                .expect("status should exist")
                .phase,
            FleetSettingsSyncPhase::Syncing
        );
    }
}
