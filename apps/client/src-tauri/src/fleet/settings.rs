use std::sync::OnceLock;

use machdoch_fleet_protocol::{
    FleetManagedSettingsDelivery, FleetManagedSettingsSyncReport, MANAGED_SETTINGS_SCHEMA_VERSION,
    MAX_MANAGED_SETTINGS_DELIVERY_BYTES,
};
use reqwest::{header, StatusCode};

use super::{
    config::validate_fleet_manager_url,
    http::{
        is_unsafe_text_character, manager_response_error, read_bounded_response, ResponseBodyError,
    },
    now_seconds, valid_identifier, FleetConnectionState, FleetSettingsSyncPhase,
    FleetSettingsSyncStatus,
};

pub async fn fetch(
    state: &FleetConnectionState,
    known_etag: Option<&str>,
) -> Result<Option<FleetManagedSettingsDelivery>, String> {
    let (config, generation) = connected_config(state)?;
    mark_sync_started(state, generation)?;
    match fetch_delivery(&config, known_etag).await {
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
    config: &super::config::FleetConnectionConfig,
    known_etag: Option<&str>,
) -> Result<Option<FleetManagedSettingsDelivery>, String> {
    let endpoint = settings_endpoint(&config, "")?;
    let client = settings_client()?;
    let mut request = client.get(endpoint).bearer_auth(&config.instance_secret);
    if let Some(etag) = known_etag {
        if etag.len() > 512 {
            return Err("Fleet settings entity tag is invalid.".to_string());
        }
        let value = header::HeaderValue::from_str(etag)
            .map_err(|_| "Fleet settings entity tag is invalid.".to_string())?;
        request = request.header(header::IF_NONE_MATCH, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Fleet settings synchronization failed: {error}"))?;
    if response.status() == StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(manager_response_error(
            response,
            "Fleet Manager rejected settings synchronization",
        )
        .await);
    }
    let body = read_bounded_response(response, MAX_MANAGED_SETTINGS_DELIVERY_BYTES)
        .await
        .map_err(settings_response_error)?;
    parse_delivery(&body, &config.manager_id).map(Some)
}

pub async fn report_applied(
    state: &FleetConnectionState,
    manager_id: &str,
    profile_id: Option<&str>,
    revision: Option<u64>,
) -> Result<(), String> {
    if (profile_id.is_none()) != (revision.is_none()) {
        return Err("Applied Fleet settings identity is invalid.".to_string());
    }
    let (config, generation) = connected_config(state)?;
    if manager_id != config.manager_id {
        return Err("Fleet Manager identity changed before settings were applied.".to_string());
    }
    let report = FleetManagedSettingsSyncReport::Applied {
        manager_id: manager_id.to_string(),
        profile_id: profile_id.map(str::to_string),
        revision,
    };
    match send_report(&config, &report).await {
        Ok(()) => mark_sync_applied(state, generation, profile_id, revision),
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
) -> Result<(), String> {
    if (profile_id.is_none()) != (revision.is_none()) {
        return Err("Failed Fleet settings identity is invalid.".to_string());
    }
    let (config, generation) = connected_config(state)?;
    if manager_id != config.manager_id {
        return Err("Fleet Manager identity changed during settings synchronization.".to_string());
    }
    let error = normalize_sync_error(error);
    mark_sync_failed(state, generation, &error)?;
    let result = send_report(
        &config,
        &FleetManagedSettingsSyncReport::Failed {
            manager_id: manager_id.to_string(),
            profile_id: profile_id.map(str::to_string),
            revision,
            error,
        },
    )
    .await;
    require_current_generation(state, generation)?;
    result
}

async fn send_report(
    config: &super::config::FleetConnectionConfig,
    report: &FleetManagedSettingsSyncReport,
) -> Result<(), String> {
    let endpoint = settings_endpoint(config, "/sync-status")?;
    let response = settings_client()?
        .put(endpoint)
        .bearer_auth(&config.instance_secret)
        .json(report)
        .send()
        .await
        .map_err(|error| format!("Fleet settings status report failed: {error}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    Err(manager_response_error(
        response,
        "Fleet Manager rejected the settings status report",
    )
    .await)
}

fn connected_config(
    state: &FleetConnectionState,
) -> Result<(super::config::FleetConnectionConfig, u64), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
    let config = inner
        .config
        .clone()
        .filter(|config| config.enabled)
        .ok_or_else(|| "Fleet Manager is not connected.".to_string())?;
    Ok((config, inner.generation))
}

fn settings_endpoint(
    config: &super::config::FleetConnectionConfig,
    suffix: &str,
) -> Result<url::Url, String> {
    validate_fleet_manager_url(&config.manager_url)?
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
    Ok(())
}

fn mark_sync_applied(
    state: &FleetConnectionState,
    generation: u64,
    profile_id: Option<&str>,
    revision: Option<u64>,
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
        last_attempt_at: now,
        last_applied_at: None,
        last_error: None,
    });
    if status.profile_id.as_deref() != profile_id {
        status.profile_name = None;
    }
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
        last_attempt_at: now,
        last_applied_at: None,
        last_error: None,
    });
    status.phase = FleetSettingsSyncPhase::Error;
    status.last_attempt_at = now;
    status.last_error = Some(normalize_sync_error(error));
    Ok(())
}

fn normalize_sync_error(error: &str) -> String {
    let normalized = error.trim();
    if normalized.is_empty() || normalized.chars().any(is_unsafe_text_character) {
        return "Fleet settings synchronization failed.".to_string();
    }
    normalized.chars().take(1_000).collect()
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
        return Err("Fleet Manager connection changed during synchronization.".to_string());
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
        .map_err(|error| format!("Fleet Manager returned invalid settings: {error}"))?;
    if delivery.schema_version != MANAGED_SETTINGS_SCHEMA_VERSION {
        return Err("Fleet Manager returned an unsupported settings schema.".to_string());
    }
    if delivery.manager_id != expected_manager_id
        || !valid_identifier(&delivery.manager_id, "manager")
    {
        return Err("Fleet Manager returned settings for another installation.".to_string());
    }
    if let Some(profile) = &delivery.profile {
        if profile.revision == 0
            || !valid_identifier(&profile.profile_id, "profile")
            || profile.name.trim().is_empty()
        {
            return Err(
                "Fleet Manager returned inconsistent settings assignment data.".to_string(),
            );
        }
    }
    Ok(delivery)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANAGER_ID: &str = "manager_MDEyMzQ1Njc4OTAxMjM0NTY3";

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

        mark_sync_applied(&state, 0, None, None).expect("sync should recover");
        let inner = state.inner.lock().expect("state should lock");
        let status = inner.settings_sync.as_ref().expect("status should exist");
        assert_eq!(status.phase, FleetSettingsSyncPhase::Applied);
        assert!(status.last_applied_at.is_some());
        assert!(status.last_error.is_none());
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
