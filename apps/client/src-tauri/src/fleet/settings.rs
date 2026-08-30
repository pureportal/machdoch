use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{config::validate_fleet_manager_url, FleetConnectionState};

const MANAGED_SETTINGS_SCHEMA_VERSION: u8 = 1;
const MAX_DELIVERY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedSettingsDelivery {
    pub schema_version: u8,
    pub assigned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<FleetManagedSettingsProfile>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedSettingsProfile {
    pub profile_id: String,
    pub name: String,
    pub revision: u64,
    pub document: FleetManagedSettingsDocument,
    pub secrets: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedSettingsDocument {
    pub defaults: FleetManagedDefaults,
    pub agent_limits: FleetManagedAgentLimits,
    pub instructions: Vec<FleetManagedInstruction>,
    pub context_packs: Vec<FleetManagedContextPack>,
    pub custom_values: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedDefaults {
    pub preferred_tooling_agent: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub reasoning: Option<String>,
    pub web_search_provider: Option<String>,
    pub theme: Option<String>,
    pub density: Option<String>,
    pub accent: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedAgentLimits {
    pub infinite: Option<bool>,
    pub executor_turns: Option<u32>,
    pub autopilot_executor_iterations: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedInstruction {
    pub id: String,
    pub name: String,
    pub body: String,
    pub enabled: bool,
    pub global: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedContextPack {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub prompt: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub reasoning: Option<String>,
    pub variables: Vec<String>,
    pub trigger_phrases: Vec<String>,
    pub path_patterns: Vec<String>,
}

pub async fn fetch(state: &FleetConnectionState) -> Result<FleetManagedSettingsDelivery, String> {
    let config = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Fleet connection state is unavailable.".to_string())?;
        inner
            .config
            .clone()
            .filter(|config| config.enabled)
            .ok_or_else(|| "Fleet Manager is not connected.".to_string())?
    };
    let manager_url = validate_fleet_manager_url(&config.manager_url)?;
    let endpoint = manager_url
        .join(&format!("/api/client/settings/{}", config.instance_id))
        .map_err(|error| format!("Fleet settings URL is invalid: {error}"))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Unable to configure Fleet settings client: {error}"))?;
    let mut response = client
        .get(endpoint)
        .bearer_auth(&config.instance_secret)
        .send()
        .await
        .map_err(|error| format!("Fleet settings synchronization failed: {error}"))?;
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
            .unwrap_or_else(|| {
                format!("Fleet Manager rejected settings synchronization ({status}).")
            });
        return Err(message);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DELIVERY_BYTES as u64)
    {
        return Err("Fleet settings response exceeded the size limit.".to_string());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Fleet settings response could not be read: {error}"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_DELIVERY_BYTES {
            return Err("Fleet settings response exceeded the size limit.".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    parse_delivery(&body, &config.manager_id)
}

fn parse_delivery(
    body: &[u8],
    expected_manager_id: &str,
) -> Result<FleetManagedSettingsDelivery, String> {
    if body.len() > MAX_DELIVERY_BYTES {
        return Err("Fleet settings response exceeded the size limit.".to_string());
    }
    let delivery = serde_json::from_slice::<FleetManagedSettingsDelivery>(body)
        .map_err(|error| format!("Fleet Manager returned invalid settings: {error}"))?;
    if delivery.schema_version != MANAGED_SETTINGS_SCHEMA_VERSION {
        return Err("Fleet Manager returned an unsupported settings schema.".to_string());
    }
    match (&delivery.manager_id, &delivery.profile, delivery.assigned) {
        (None, None, false) => Ok(delivery),
        (Some(manager_id), Some(profile), true)
            if manager_id == expected_manager_id
                && profile.revision > 0
                && !profile.profile_id.trim().is_empty()
                && !profile.name.trim().is_empty() =>
        {
            Ok(delivery)
        }
        _ => Err("Fleet Manager returned inconsistent settings assignment data.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unassigned_delivery() {
        let delivery = parse_delivery(
            br#"{"schemaVersion":1,"assigned":false}"#,
            "manager_expected",
        )
        .expect("delivery should parse");

        assert!(!delivery.assigned);
        assert!(delivery.profile.is_none());
    }

    #[test]
    fn rejects_delivery_from_another_manager() {
        let result = parse_delivery(
            br#"{
                "schemaVersion": 1,
                "assigned": true,
                "managerId": "manager_other",
                "profile": {
                    "profileId": "profile_one",
                    "name": "Default",
                    "revision": 1,
                    "document": {
                        "defaults": {
                            "preferredToolingAgent": null,
                            "provider": null,
                            "model": null,
                            "mode": null,
                            "reasoning": null,
                            "webSearchProvider": null,
                            "theme": null,
                            "density": null,
                            "accent": null
                        },
                        "agentLimits": {
                            "infinite": null,
                            "executorTurns": null,
                            "autopilotExecutorIterations": null
                        },
                        "instructions": [],
                        "contextPacks": [],
                        "customValues": {}
                    },
                    "secrets": {}
                }
            }"#,
            "manager_expected",
        );

        assert!(result.is_err());
    }
}
