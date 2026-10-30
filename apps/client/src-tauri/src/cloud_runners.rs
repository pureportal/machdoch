use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read},
    process::Stdio,
    sync::{Arc, Mutex},
    thread,
};

use machdoch_process::SupervisedChild;
use serde::Serialize;

const MAXIMUM_MESSAGE_CHARACTERS: usize = 600;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RunnerPhase {
    Running,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRunnerView {
    id: String,
    phase: RunnerPhase,
    message: Option<String>,
    last_task: Option<String>,
}

#[derive(Default)]
struct RunnerOutput {
    error: Option<String>,
    last_task: Option<String>,
}

struct ManagedRunner {
    child: Option<SupervisedChild>,
    phase: RunnerPhase,
    output: Arc<Mutex<RunnerOutput>>,
}

#[derive(Clone, Default)]
pub struct CloudRunnerState {
    runners: Arc<Mutex<HashMap<String, ManagedRunner>>>,
}

impl CloudRunnerState {
    pub fn shutdown(&self) {
        if let Ok(mut runners) = self.runners.lock() {
            for runner in runners.values_mut() {
                if let Some(mut child) = runner.child.take() {
                    let _ = child.terminate_and_reap();
                }
            }
        }
    }

    fn views(runners: &mut HashMap<String, ManagedRunner>) -> Vec<CloudRunnerView> {
        let mut views: Vec<CloudRunnerView> = runners
            .iter_mut()
            .map(|(id, runner)| {
                if let Some(child) = runner.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            runner.phase = if status.success() {
                                RunnerPhase::Stopped
                            } else {
                                RunnerPhase::Failed
                            };
                            runner.child = None;
                        }
                        Ok(None) => {}
                        Err(_) => {
                            let _ = child.terminate_and_reap();
                            runner.phase = RunnerPhase::Failed;
                            runner.child = None;
                        }
                    }
                }
                let output = runner.output.lock().ok();
                CloudRunnerView {
                    id: id.clone(),
                    phase: runner.phase,
                    message: match runner.phase {
                        RunnerPhase::Failed => output.as_ref().and_then(|value| value.error.clone()),
                        _ => None,
                    },
                    last_task: output.as_ref().and_then(|value| value.last_task.clone()),
                }
            })
            .collect();
        views.sort_by(|left, right| left.id.cmp(&right.id));
        views
    }
}

fn validate_connection_id(id: &str) -> Result<(), String> {
    let valid = id.len() == 36
        && id.char_indices().all(|(index, character)| match index {
            8 | 13 | 18 | 23 => character == '-',
            _ => character.is_ascii_hexdigit(),
        });
    if valid {
        Ok(())
    } else {
        Err("Choose a linked workspace connection.".to_string())
    }
}

fn authorize_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Cloud task runners can only be managed in the main desktop window.".to_string())
    }
}

fn bounded(text: &str) -> String {
    text.trim().chars().take(MAXIMUM_MESSAGE_CHARACTERS).collect()
}

fn collect_errors(stream: impl Read + Send + 'static, output: Arc<Mutex<RunnerOutput>>) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let message = bounded(&line);
            if !message.is_empty() {
                if let Ok(mut current) = output.lock() {
                    current.error = Some(message);
                }
            }
        }
    });
}

fn collect_results(stream: impl Read + Send + 'static, output: Arc<Mutex<RunnerOutput>>) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let state = serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|value| value["state"].as_str().map(bounded));
            if let (Some(state), Ok(mut current)) = (state, output.lock()) {
                current.last_task = Some(state);
            }
        }
    });
}

fn start(state: &CloudRunnerState, id: &str) -> Result<Vec<CloudRunnerView>, String> {
    validate_connection_id(id)?;
    let mut runners = state
        .runners
        .lock()
        .map_err(|_| "Cloud task runner state is unavailable.".to_string())?;
    CloudRunnerState::views(&mut runners);
    if runners
        .get(id)
        .is_some_and(|runner| runner.phase == RunnerPhase::Running)
    {
        return Ok(CloudRunnerState::views(&mut runners));
    }
    let mut shared = crate::shared_cli::create_shared_cli_command(&[
        "cloud".to_string(),
        "run".to_string(),
        id.to_string(),
        "--json".to_string(),
    ])?;
    shared
        .command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = SupervisedChild::spawn(&mut shared.command)
        .map_err(|_| "The cloud task runner could not start.".to_string())?;
    let output = Arc::new(Mutex::new(RunnerOutput::default()));
    if let Some(stdout) = child.stdout.take() {
        collect_results(stdout, output.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        collect_errors(stderr, output.clone());
    }
    runners.insert(
        id.to_string(),
        ManagedRunner {
            child: Some(child),
            phase: RunnerPhase::Running,
            output,
        },
    );
    Ok(CloudRunnerState::views(&mut runners))
}

fn stop(state: &CloudRunnerState, id: &str) -> Result<Vec<CloudRunnerView>, String> {
    validate_connection_id(id)?;
    let mut runners = state
        .runners
        .lock()
        .map_err(|_| "Cloud task runner state is unavailable.".to_string())?;
    if let Some(runner) = runners.get_mut(id) {
        if let Some(mut child) = runner.child.take() {
            child
                .terminate_and_reap()
                .map_err(|_| "The cloud task runner could not be stopped.".to_string())?;
        }
        runner.phase = RunnerPhase::Stopped;
    }
    Ok(CloudRunnerState::views(&mut runners))
}

fn list(state: &CloudRunnerState) -> Result<Vec<CloudRunnerView>, String> {
    let mut runners = state
        .runners
        .lock()
        .map_err(|_| "Cloud task runner state is unavailable.".to_string())?;
    Ok(CloudRunnerState::views(&mut runners))
}

async fn blocking(
    state: &CloudRunnerState,
    operation: impl FnOnce(&CloudRunnerState) -> Result<Vec<CloudRunnerView>, String> + Send + 'static,
) -> Result<Vec<CloudRunnerView>, String> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&state))
        .await
        .map_err(|_| "The cloud task runner request stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn cloud_runner_list(
    window: tauri::Window,
    state: tauri::State<'_, CloudRunnerState>,
) -> Result<Vec<CloudRunnerView>, String> {
    authorize_window(window.label())?;
    blocking(&state, list).await
}

#[tauri::command]
pub async fn cloud_runner_start(
    window: tauri::Window,
    state: tauri::State<'_, CloudRunnerState>,
    id: String,
) -> Result<Vec<CloudRunnerView>, String> {
    authorize_window(window.label())?;
    blocking(&state, move |state| start(state, &id)).await
}

#[tauri::command]
pub async fn cloud_runner_stop(
    window: tauri::Window,
    state: tauri::State<'_, CloudRunnerState>,
    id: String,
) -> Result<Vec<CloudRunnerView>, String> {
    authorize_window(window.label())?;
    blocking(&state, move |state| stop(state, &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_requests_accept_only_connection_ids_from_the_main_window() {
        assert!(validate_connection_id("0b8f5a52-7c1e-4d39-9a4e-2f6c7d8e9a10").is_ok());
        for id in ["", "../connection", "0b8f5a52-7c1e-4d39-9a4e-2f6c7d8e9a1", "0b8f5a52x7c1e-4d39-9a4e-2f6c7d8e9a10"] {
            assert!(validate_connection_id(id).is_err());
        }
        assert!(authorize_window("main").is_ok());
        assert!(authorize_window("preview").is_err());
    }

    #[test]
    fn stopping_an_unknown_runner_reports_the_current_state() {
        let state = CloudRunnerState::default();
        assert!(stop(&state, "0b8f5a52-7c1e-4d39-9a4e-2f6c7d8e9a10")
            .unwrap()
            .is_empty());
        assert!(list(&state).unwrap().is_empty());
    }

    #[test]
    fn runner_output_keeps_bounded_messages() {
        let long = "x".repeat(MAXIMUM_MESSAGE_CHARACTERS + 50);
        assert_eq!(bounded(&long).chars().count(), MAXIMUM_MESSAGE_CHARACTERS);
        let output = Arc::new(Mutex::new(RunnerOutput::default()));
        collect_results(
            std::io::Cursor::new(b"{\"runId\":\"a\",\"state\":\"succeeded\"}\nnot json\n".to_vec()),
            output.clone(),
        );
        for _ in 0..100 {
            if output.lock().unwrap().last_task.is_some() {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(output.lock().unwrap().last_task.as_deref(), Some("succeeded"));
    }
}
