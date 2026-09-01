use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

const MAX_ACTIVE_AGENTS: usize = 128;
const MAX_CONNECTION_AGENTS: usize = 8;
const MAX_AGENT_ID_CHARS: usize = 128;
const MAX_CLAIM_PATHS: usize = 32;
const MAX_CLAIM_RESOURCES: usize = 16;
const MAX_CLAIM_CHARS: usize = 256;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum WorkspaceAgentRole {
    Parent,
    Worker,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum WorkspaceAgentAccess {
    ReadOnly,
    Write,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum WorkspaceAgentActivity {
    Executor,
    Validator,
    Generator,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkspaceAgentClaims {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) read_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) write_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) exclusive_resources: Vec<String>,
}

impl WorkspaceAgentClaims {
    fn validate(&self) -> Result<(), String> {
        validate_claims("readPaths", &self.read_paths, MAX_CLAIM_PATHS)?;
        validate_claims("writePaths", &self.write_paths, MAX_CLAIM_PATHS)?;
        validate_claims(
            "exclusiveResources",
            &self.exclusive_resources,
            MAX_CLAIM_RESOURCES,
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkspaceAgentRegistration {
    pub(super) agent_id: String,
    pub(super) registration_key: String,
    pub(super) parent_agent_id: Option<String>,
    pub(super) role: WorkspaceAgentRole,
    pub(super) access: WorkspaceAgentAccess,
    pub(super) activity: WorkspaceAgentActivity,
    #[serde(default)]
    pub(super) claims: WorkspaceAgentClaims,
}

impl WorkspaceAgentRegistration {
    fn validate(&self) -> Result<(), String> {
        validate_agent_id("agentId", &self.agent_id)?;
        validate_agent_id("registrationKey", &self.registration_key)?;
        if let Some(parent_agent_id) = self.parent_agent_id.as_deref() {
            validate_agent_id("parentAgentId", parent_agent_id)?;
            if parent_agent_id == self.agent_id {
                return Err("Workspace agent parentAgentId must differ from agentId.".to_string());
            }
        }
        match (self.role, self.parent_agent_id.is_some()) {
            (WorkspaceAgentRole::Parent, true) => {
                return Err("A parent workspace agent cannot have parentAgentId.".to_string());
            }
            (WorkspaceAgentRole::Worker, false) => {
                return Err("A worker workspace agent requires parentAgentId.".to_string());
            }
            _ => {}
        }
        self.claims.validate()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActiveWorkspaceAgent {
    agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_agent_id: Option<String>,
    role: WorkspaceAgentRole,
    access: WorkspaceAgentAccess,
    activity: WorkspaceAgentActivity,
    started_at: u64,
    #[serde(skip_serializing_if = "claims_are_empty")]
    claims: WorkspaceAgentClaims,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspacePresenceSnapshot {
    status: WorkspacePresenceStatus,
    agents: Vec<ActiveWorkspaceAgent>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum WorkspacePresenceStatus {
    Available,
}

struct StoredWorkspaceAgent {
    connection_id: u64,
    registration_key: String,
    workspace_root: String,
    agent: ActiveWorkspaceAgent,
}

#[derive(Default)]
struct WorkspacePresenceState {
    agents: HashMap<String, StoredWorkspaceAgent>,
    connection_agents: HashMap<u64, HashSet<String>>,
}

#[derive(Default)]
pub(super) struct WorkspacePresenceRegistry(Mutex<WorkspacePresenceState>);

impl WorkspacePresenceRegistry {
    pub(super) fn register(
        &self,
        connection_id: u64,
        workspace_root: String,
        registration: WorkspaceAgentRegistration,
    ) -> Result<(), String> {
        registration.validate()?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Workspace presence is unavailable.".to_string())?;
        let existing = state.agents.get(&registration.agent_id).map(|agent| {
            (
                agent.connection_id,
                agent.registration_key == registration.registration_key,
                agent.agent.started_at,
            )
        });
        if existing.is_some_and(|(_, registration_key_matches, _)| !registration_key_matches) {
            return Err("Workspace agentId is already registered.".to_string());
        }
        if existing.is_none() && state.agents.len() >= MAX_ACTIVE_AGENTS {
            return Err("Workspace presence capacity has been reached.".to_string());
        }
        let already_owned_by_connection = existing
            .is_some_and(|(owner_connection_id, _, _)| owner_connection_id == connection_id);
        if !already_owned_by_connection
            && state
                .connection_agents
                .get(&connection_id)
                .is_some_and(|agents| agents.len() >= MAX_CONNECTION_AGENTS)
        {
            return Err("Workspace presence connection capacity has been reached.".to_string());
        }
        if let Some(parent_agent_id) = registration.parent_agent_id.as_deref() {
            let parent_is_owned = state.agents.get(parent_agent_id).is_some_and(|parent| {
                parent.connection_id == connection_id && parent.workspace_root == workspace_root
            });
            if !parent_is_owned {
                return Err(
                    "Workspace presence parentAgentId is not registered on this connection."
                        .to_string(),
                );
            }
        }

        let agent_id = registration.agent_id.clone();
        if let Some((owner_connection_id, _, _)) = existing {
            if owner_connection_id != connection_id {
                if let Some(agent_ids) = state.connection_agents.get_mut(&owner_connection_id) {
                    agent_ids.remove(&agent_id);
                    if agent_ids.is_empty() {
                        state.connection_agents.remove(&owner_connection_id);
                    }
                }
            }
        }
        state.agents.insert(
            agent_id.clone(),
            StoredWorkspaceAgent {
                connection_id,
                registration_key: registration.registration_key,
                workspace_root,
                agent: ActiveWorkspaceAgent {
                    agent_id: registration.agent_id,
                    parent_agent_id: registration.parent_agent_id,
                    role: registration.role,
                    access: registration.access,
                    activity: registration.activity,
                    started_at: existing
                        .map(|(_, _, started_at)| started_at)
                        .unwrap_or_else(current_timestamp_ms),
                    claims: registration.claims,
                },
            },
        );
        state
            .connection_agents
            .entry(connection_id)
            .or_default()
            .insert(agent_id);
        Ok(())
    }

    pub(super) fn unregister_agent(
        &self,
        connection_id: u64,
        agent_id: &str,
    ) -> Result<(), String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Workspace presence is unavailable.".to_string())?;
        let is_owner = state
            .agents
            .get(agent_id)
            .is_some_and(|agent| agent.connection_id == connection_id);
        if !is_owner {
            return Err(
                "Workspace agent registration was not found on this connection.".to_string(),
            );
        }
        state.agents.remove(agent_id);
        if let Some(agent_ids) = state.connection_agents.get_mut(&connection_id) {
            agent_ids.remove(agent_id);
            if agent_ids.is_empty() {
                state.connection_agents.remove(&connection_id);
            }
        }
        Ok(())
    }

    pub(super) fn unregister_connection(&self, connection_id: u64) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        let Some(agent_ids) = state.connection_agents.remove(&connection_id) else {
            return;
        };
        for agent_id in agent_ids {
            if state
                .agents
                .get(&agent_id)
                .is_some_and(|agent| agent.connection_id == connection_id)
            {
                state.agents.remove(&agent_id);
            }
        }
    }

    pub(super) fn snapshot(
        &self,
        workspace_root: &str,
        requester_agent_id: Option<&str>,
    ) -> Result<WorkspacePresenceSnapshot, String> {
        let state = self
            .0
            .lock()
            .map_err(|_| "Workspace presence is unavailable.".to_string())?;
        let mut agents = state
            .agents
            .values()
            .filter(|entry| entry.workspace_root == workspace_root)
            .filter(|entry| requester_agent_id != Some(entry.agent.agent_id.as_str()))
            .map(|entry| entry.agent.clone())
            .collect::<Vec<_>>();
        agents.sort_by(|left, right| {
            left.started_at
                .cmp(&right.started_at)
                .then_with(|| left.agent_id.cmp(&right.agent_id))
        });
        Ok(WorkspacePresenceSnapshot {
            status: WorkspacePresenceStatus::Available,
            agents,
        })
    }

    pub(super) fn clear(&self) {
        if let Ok(mut state) = self.0.lock() {
            *state = WorkspacePresenceState::default();
        }
    }

    #[cfg(test)]
    pub(super) fn active_count(&self) -> usize {
        self.0.lock().map_or(0, |state| state.agents.len())
    }
}

fn validate_agent_id(field: &str, value: &str) -> Result<(), String> {
    let character_count = value.chars().count();
    if character_count == 0
        || character_count > MAX_AGENT_ID_CHARS
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("Workspace presence {field} is invalid."));
    }
    Ok(())
}

fn validate_claims(field: &str, values: &[String], limit: usize) -> Result<(), String> {
    if values.len() > limit
        || values.iter().any(|value| {
            value.trim().is_empty()
                || value.chars().count() > MAX_CLAIM_CHARS
                || value.chars().any(char::is_control)
        })
    {
        return Err(format!("Workspace presence {field} is invalid."));
    }
    Ok(())
}

fn claims_are_empty(claims: &WorkspaceAgentClaims) -> bool {
    claims.read_paths.is_empty()
        && claims.write_paths.is_empty()
        && claims.exclusive_resources.is_empty()
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(agent_id: &str) -> WorkspaceAgentRegistration {
        WorkspaceAgentRegistration {
            agent_id: agent_id.to_string(),
            registration_key: format!("{agent_id}-key"),
            parent_agent_id: None,
            role: WorkspaceAgentRole::Parent,
            access: WorkspaceAgentAccess::Write,
            activity: WorkspaceAgentActivity::Executor,
            claims: WorkspaceAgentClaims::default(),
        }
    }

    #[test]
    fn discovers_only_other_agents_in_the_same_workspace() {
        let registry = WorkspacePresenceRegistry::default();
        registry
            .register(1, "C:/workspace".to_string(), registration("agent-a"))
            .expect("first registration should succeed");
        registry
            .register(2, "C:/workspace".to_string(), registration("agent-b"))
            .expect("second registration should succeed");
        registry
            .register(3, "C:/other".to_string(), registration("agent-c"))
            .expect("other workspace registration should succeed");

        let snapshot = registry
            .snapshot("C:/workspace", Some("agent-a"))
            .expect("presence should be readable");

        assert_eq!(snapshot.agents.len(), 1);
        assert_eq!(snapshot.agents[0].agent_id, "agent-b");
    }

    #[test]
    fn removes_every_registration_owned_by_a_closed_connection() {
        let registry = WorkspacePresenceRegistry::default();
        registry
            .register(7, "C:/workspace".to_string(), registration("parent"))
            .expect("parent registration should succeed");
        registry
            .register(
                7,
                "C:/workspace".to_string(),
                WorkspaceAgentRegistration {
                    agent_id: "worker".to_string(),
                    registration_key: "worker-key".to_string(),
                    parent_agent_id: Some("parent".to_string()),
                    role: WorkspaceAgentRole::Worker,
                    access: WorkspaceAgentAccess::ReadOnly,
                    activity: WorkspaceAgentActivity::Executor,
                    claims: WorkspaceAgentClaims::default(),
                },
            )
            .expect("worker registration should succeed");

        registry.unregister_connection(7);

        assert_eq!(registry.active_count(), 0);
    }

    #[test]
    fn rejects_a_worker_without_a_connection_owned_parent() {
        let registry = WorkspacePresenceRegistry::default();

        let result = registry.register(
            7,
            "C:/workspace".to_string(),
            WorkspaceAgentRegistration {
                agent_id: "worker".to_string(),
                registration_key: "worker-key".to_string(),
                parent_agent_id: Some("missing-parent".to_string()),
                role: WorkspaceAgentRole::Worker,
                access: WorkspaceAgentAccess::ReadOnly,
                activity: WorkspaceAgentActivity::Executor,
                claims: WorkspaceAgentClaims::default(),
            },
        );

        assert_eq!(
            result,
            Err(
                "Workspace presence parentAgentId is not registered on this connection."
                    .to_string()
            )
        );
        assert_eq!(registry.active_count(), 0);
    }

    #[test]
    fn reconnects_a_registration_without_old_connection_cleanup_removing_it() {
        let registry = WorkspacePresenceRegistry::default();
        registry
            .register(1, "C:/workspace".to_string(), registration("agent-a"))
            .expect("initial registration should succeed");
        registry
            .register(2, "C:/workspace".to_string(), registration("agent-a"))
            .expect("reconnected registration should succeed");

        registry.unregister_connection(1);

        assert_eq!(registry.active_count(), 1);
        assert_eq!(
            registry
                .snapshot("C:/workspace", None)
                .expect("reconnected presence should be readable")
                .agents[0]
                .agent_id,
            "agent-a"
        );
        registry.unregister_connection(2);
        assert_eq!(registry.active_count(), 0);
    }
}
