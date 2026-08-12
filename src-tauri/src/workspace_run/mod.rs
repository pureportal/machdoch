mod control;
mod detection;
mod health;
mod manager;
pub mod model;
mod persistence;
mod process;

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::Value;
use tauri::{Emitter as _, Manager as _};

use self::{
    control::{ControlCredentials, RunControlBridge},
    detection::detect_configurations,
    manager::RunManager,
    model::{
        RunConfigurationDocument, RunDetectionResult, RunWorkspaceSnapshot, RUN_EVENT_NAME,
        RUN_LOG_EVENT_NAME,
    },
};
use crate::runtime_snapshot::resolve_workspace_root_path;

const MAX_AI_COMMAND_CHARS: usize = 512;
const MAX_AI_URL_CHARS: usize = 256;
const MAX_AI_DIAGNOSTIC_CHARS: usize = 512;
const MAX_AI_ENVIRONMENT_NAMES: usize = 16;
const MAX_AI_LOG_ENTRIES: usize = 3;
const MAX_AI_FAILURE_ENTRIES: usize = 2;

#[derive(Default)]
pub struct WorkspaceRunState {
    manager: Arc<RunManager>,
    control_bridge: Mutex<Option<RunControlBridge>>,
}

impl WorkspaceRunState {
    pub fn initialize(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let event_app = app.clone();
        self.manager.set_event_sink(Arc::new(move |snapshot| {
            let _ = event_app.emit(RUN_EVENT_NAME, snapshot);
        }));
        let log_event_app = app.clone();
        self.manager.set_log_event_sink(Arc::new(move |batch| {
            let _ = log_event_app.emit(RUN_LOG_EVENT_NAME, batch);
        }));
        let mut bridge = self
            .control_bridge
            .lock()
            .map_err(|_| "Run-control state is unavailable.".to_string())?;
        if bridge.is_none() {
            *bridge = Some(RunControlBridge::start(self.manager.clone())?);
        }
        Ok(())
    }

    pub fn manager(&self) -> Arc<RunManager> {
        self.manager.clone()
    }

    pub fn control_credentials(&self) -> Option<ControlCredentials> {
        self.control_bridge
            .lock()
            .ok()
            .and_then(|bridge| bridge.as_ref().map(RunControlBridge::credentials))
    }

    pub fn shutdown(&self) {
        self.manager.shutdown();
        if let Ok(mut bridge) = self.control_bridge.lock() {
            if let Some(bridge) = bridge.as_mut() {
                bridge.shutdown();
            }
            *bridge = None;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfigurationRequest {
    workspace_root: String,
    configuration_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRunConfigurationRequest {
    workspace_root: String,
    document: RunConfigurationDocument,
}

#[tauri::command]
pub fn get_workspace_run_configuration_document(
    state: tauri::State<'_, WorkspaceRunState>,
    workspace_root: String,
) -> Result<RunConfigurationDocument, String> {
    state.manager.load_configuration_document(&workspace_root)
}

#[tauri::command]
pub fn save_workspace_run_configuration_document(
    state: tauri::State<'_, WorkspaceRunState>,
    request: SaveRunConfigurationRequest,
) -> Result<RunWorkspaceSnapshot, String> {
    state
        .manager
        .save_configuration_document(&request.workspace_root, &request.document)
}

#[tauri::command]
pub fn get_workspace_run_snapshot(
    state: tauri::State<'_, WorkspaceRunState>,
    workspace_root: String,
) -> Result<RunWorkspaceSnapshot, String> {
    state.manager.snapshot(&workspace_root)
}

#[tauri::command]
pub fn start_workspace_run_configuration(
    state: tauri::State<'_, WorkspaceRunState>,
    request: RunConfigurationRequest,
) -> Result<RunWorkspaceSnapshot, String> {
    state
        .manager
        .start(&request.workspace_root, request.configuration_id.as_deref())
}

#[tauri::command]
pub fn stop_workspace_run_configuration(
    state: tauri::State<'_, WorkspaceRunState>,
    request: RunConfigurationRequest,
) -> Result<RunWorkspaceSnapshot, String> {
    state
        .manager
        .stop(&request.workspace_root, request.configuration_id.as_deref())
}

#[tauri::command]
pub async fn restart_workspace_run_configuration(
    state: tauri::State<'_, WorkspaceRunState>,
    request: RunConfigurationRequest,
) -> Result<RunWorkspaceSnapshot, String> {
    let manager = state.manager();
    tauri::async_runtime::spawn_blocking(move || {
        manager.restart(&request.workspace_root, request.configuration_id.as_deref())
    })
    .await
    .map_err(|error| format!("Run restart worker failed: {error}"))?
}

#[tauri::command]
pub fn detect_workspace_run_configurations(
    workspace_root: String,
) -> Result<RunDetectionResult, String> {
    let workspace = resolve_workspace_root_path(&workspace_root)?;
    detect_configurations(&workspace)
}

pub fn enrich_conversation_context(
    app: &tauri::AppHandle,
    workspace_root: &str,
    conversation_context: Option<Value>,
) -> Result<Option<Value>, String> {
    let state = app.state::<WorkspaceRunState>();
    let mut context = conversation_context.unwrap_or_else(|| serde_json::json!({ "history": [] }));
    let Value::Object(context_object) = &mut context else {
        return Err("Expected the desktop conversation context to be a JSON object.".to_string());
    };
    let mut snapshot = state.manager.snapshot(workspace_root)?;
    trim_snapshot_for_ai(&mut snapshot);
    context_object.insert(
        "workspaceRun".to_string(),
        serde_json::to_value(snapshot)
            .map_err(|error| format!("Failed to serialize workspace run context: {error}"))?,
    );
    Ok(Some(context))
}

fn trim_snapshot_for_ai(snapshot: &mut RunWorkspaceSnapshot) {
    for status in &mut snapshot.configurations {
        trim_status_for_ai(status);
    }
}

fn trim_status_for_ai(status: &mut model::RunConfigurationStatus) {
    let mut environment_values = match &status.configuration {
        model::RunConfiguration::Task { environment, .. } => environment
            .values()
            .filter(|value| !value.is_empty() && value.as_str() != "<redacted>")
            .cloned()
            .collect::<Vec<_>>(),
        model::RunConfiguration::Composite { .. } => Vec::new(),
    };
    environment_values
        .sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    environment_values.dedup();

    if let model::RunConfiguration::Task {
        command,
        working_directory,
        environment,
        urls,
        health_check,
        ..
    } = &mut status.configuration
    {
        redact_text(command, &environment_values);
        redact_text(working_directory, &environment_values);
        limit_ai_text(command, MAX_AI_COMMAND_CHARS);
        for url in urls {
            redact_text(url, &environment_values);
            limit_ai_text(url, MAX_AI_URL_CHARS);
        }
        if let Some(health_check) = health_check {
            if let Some(host) = &mut health_check.host {
                redact_text(host, &environment_values);
                limit_ai_text(host, MAX_AI_URL_CHARS);
            }
            if let Some(url) = &mut health_check.url {
                redact_text(url, &environment_values);
                limit_ai_text(url, MAX_AI_URL_CHARS);
            }
        }
        for value in environment.values_mut() {
            *value = "<redacted>".to_string();
        }
        let mut retained_names = 0;
        environment.retain(|_, _| {
            retained_names += 1;
            retained_names <= MAX_AI_ENVIRONMENT_NAMES
        });
    }
    if let Some(message) = status
        .health
        .as_mut()
        .and_then(|health| health.message.as_mut())
    {
        redact_text(message, &environment_values);
        limit_ai_text(message, MAX_AI_DIAGNOSTIC_CHARS);
    }
    for failure in &mut status.recent_failures {
        redact_text(&mut failure.message, &environment_values);
        limit_ai_text(&mut failure.message, MAX_AI_DIAGNOSTIC_CHARS);
    }
    for log in &mut status.logs {
        redact_text(&mut log.line, &environment_values);
        limit_ai_text(&mut log.line, MAX_AI_DIAGNOSTIC_CHARS);
    }
    if status.logs.len() > MAX_AI_LOG_ENTRIES {
        status.logs = status
            .logs
            .split_off(status.logs.len() - MAX_AI_LOG_ENTRIES);
    }
    if status.recent_failures.len() > MAX_AI_FAILURE_ENTRIES {
        status.recent_failures = status
            .recent_failures
            .split_off(status.recent_failures.len() - MAX_AI_FAILURE_ENTRIES);
    }
    for child in &mut status.children {
        trim_status_for_ai(child);
    }
}

fn redact_text(value: &mut String, secrets: &[String]) {
    for secret in secrets {
        if value.contains(secret) {
            *value = value.replace(secret, "<redacted>");
        }
    }
}

fn limit_ai_text(value: &mut String, max_chars: usize) {
    let Some((end, _)) = value.char_indices().nth(max_chars) else {
        return;
    };
    value.truncate(end);
    value.push_str("...");
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::workspace_run::model::{
        RunConfiguration, RunConfigurationStatus, RunLifecycleState, RunRestartPolicy,
    };

    #[test]
    fn ai_snapshots_redact_environment_values() {
        let mut environment =
            BTreeMap::from([("API_TOKEN".to_string(), "secret-value".to_string())]);
        for index in 0..20 {
            environment.insert(format!("EXTRA_{index:02}"), format!("value-{index:02}"));
        }
        let mut snapshot = RunWorkspaceSnapshot {
            workspace_root: "C:/workspace".to_string(),
            primary_configuration_id: Some("server".to_string()),
            configurations: vec![RunConfigurationStatus {
                configuration: RunConfiguration::Task {
                    id: "server".to_string(),
                    name: "Server".to_string(),
                    command: "start-server secret-value".to_string(),
                    working_directory: ".".to_string(),
                    environment,
                    hot_reload: false,
                    ports: Vec::new(),
                    urls: Vec::new(),
                    health_check: None,
                    restart_policy: RunRestartPolicy::default(),
                },
                state: RunLifecycleState::Stopped,
                pid: None,
                started_at: None,
                stopped_at: None,
                exit_code: None,
                restart_count: 0,
                health: None,
                recent_failures: (0..5)
                    .map(|index| model::RunFailure {
                        at: index,
                        kind: model::RunFailureKind::Launch,
                        message: format!("launch exposed secret-value {}", "x".repeat(2_000)),
                    })
                    .collect(),
                logs: (0..10)
                    .map(|index| model::RunLogEntry {
                        sequence: index,
                        at: index,
                        stream: model::RunLogStream::Stderr,
                        line: format!("output exposed secret-value {}", "x".repeat(2_000)),
                    })
                    .collect(),
                children: Vec::new(),
            }],
        };

        trim_snapshot_for_ai(&mut snapshot);

        let RunConfiguration::Task { environment, .. } = &snapshot.configurations[0].configuration
        else {
            panic!("expected task configuration");
        };
        assert_eq!(
            environment.get("API_TOKEN").map(String::as_str),
            Some("<redacted>")
        );
        assert_eq!(environment.len(), MAX_AI_ENVIRONMENT_NAMES);
        assert_eq!(snapshot.configurations[0].logs.len(), MAX_AI_LOG_ENTRIES);
        assert_eq!(
            snapshot.configurations[0].recent_failures.len(),
            MAX_AI_FAILURE_ENTRIES
        );
        assert!(snapshot.configurations[0]
            .logs
            .iter()
            .all(|entry| entry.line.chars().count() <= MAX_AI_DIAGNOSTIC_CHARS + 3));
        assert!(!serde_json::to_string(&snapshot)
            .expect("snapshot should serialize")
            .contains("secret-value"));
    }
}
