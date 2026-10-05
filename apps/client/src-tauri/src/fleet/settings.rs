use std::sync::OnceLock;

use machdoch_fleet_protocol::{
    FleetManagedSettingsDelivery, FleetManagedSettingsDocument, FleetManagedSettingsSyncReport,
    MANAGED_SETTINGS_SCHEMA_VERSION, MAX_MANAGED_SETTINGS_DELIVERY_BYTES,
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

pub async fn capture_enrollment(
    state: &FleetConnectionState,
    manager_id: &str,
    instance_id: &str,
    document: FleetManagedSettingsDocument,
) -> Result<(), String> {
    let (config, generation) = connected_config(state)?;
    if config.manager_id != manager_id || config.instance_id != instance_id {
        return Err(
            "Fleet Manager connection changed before device settings were captured.".to_string(),
        );
    }
    let body = serde_json::to_vec(&document)
        .map_err(|error| format!("Device settings could not be read: {error}"))?;
    if body.len() > MAX_MANAGED_SETTINGS_DELIVERY_BYTES {
        return Err("Device settings exceed the size limit.".to_string());
    }
    let response = settings_client()?
        .put(settings_endpoint(&config, "/enrollment")?)
        .bearer_auth(&config.instance_secret)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("Device settings could not be captured: {error}"))?;
    require_current_generation(state, generation)?;
    if !response.status().is_success() {
        return Err(
            manager_response_error(response, "Fleet Manager rejected device settings").await,
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
    let response = settings_client()?
        .get(settings_endpoint(&config, "/enrollment")?)
        .bearer_auth(&config.instance_secret)
        .send()
        .await
        .map_err(|error| format!("Device settings status is unavailable: {error}"))?;
    require_current_generation(state, generation)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err("Update Fleet Manager to capture device settings.".to_string());
    }
    if !response.status().is_success() {
        return Err(
            manager_response_error(response, "Fleet Manager rejected device settings").await,
        );
    }
    let body = read_bounded_response(response, 1024)
        .await
        .map_err(settings_response_error)?;
    let status: CaptureStatus = serde_json::from_slice(&body)
        .map_err(|_| "Fleet Manager returned invalid device settings status.".to_string())?;
    require_current_generation(state, generation)?;
    Ok(status.capture_required)
}
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
                "Fleet Manager connection changed before device settings were captured."
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
