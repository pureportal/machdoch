use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    sync::Arc,
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tauri::Manager as _;

use crate::{
    child_process::{SupervisedChild, SupervisedChildSpawnError},
    runtime_snapshot::resolve_workspace_root_path,
};

use super::{
    diagnostics::{format_command_failure, format_timeout_duration},
    payload::cleanup_temporary_files,
    payload_files::rewrite_ralph_payload_arguments,
    process::{
        join_cli_output_and_cleanup, read_bounded_stream_text_with_limit, read_stderr,
        SUBPROCESS_OUTPUT_TRUNCATED_MARKER,
    },
    progress::{create_bridge_progress, emit_progress_event},
    ralph_media_bridge::RalphMediaBridge,
    ralph_recovery::{
        recovery_inspection_arguments, supervise_ralph_command, RalphCommandAttempt,
        RALPH_RUN_ID_ENV,
    },
    registry::normalize_task_id,
    OpenRalphFlowPathRequest, RalphCommandRequest, DESKTOP_TASK_WAIT_POLL_MS,
    RALPH_COMMAND_TIMEOUT_MS,
};

const RALPH_CANCEL_PATH_ENV: &str = "MACHDOCH_RALPH_CANCEL_PATH";
const RALPH_GRACEFUL_STOP_TIMEOUT_MS: u64 = 30_000;
// Run details retain bounded text per event and result but can include hundreds
// of transitions. Keep the transport bounded without applying the 1 MiB
// diagnostic cap to valid persisted records.
const RALPH_RESPONSE_CAPTURE_LIMIT_BYTES: usize = 128 * 1024 * 1024;
static NEXT_RALPH_CANCEL_REQUEST_ID: AtomicU64 = AtomicU64::new(0);

fn ralph_command_timeout_ms(action: &str) -> Option<u64> {
    match action {
        "run" | "resume" => None,
        "snapshot" | "list" | "runs" | "run-detail" => Some(60_000),
        _ => Some(RALPH_COMMAND_TIMEOUT_MS),
    }
}

fn create_ralph_cancel_path() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_RALPH_CANCEL_REQUEST_ID.fetch_add(1, Ordering::Relaxed);

    std::env::temp_dir().join(format!(
        "machdoch-ralph-cancel-{}-{timestamp}-{sequence}.request",
        std::process::id()
    ))
}

fn request_ralph_cli_stop(
    child: &mut SupervisedChild,
    cancellation_path: &Path,
    reason: &str,
    allow_graceful_stop: bool,
) {
    let request_written = fs::write(cancellation_path, reason).is_ok();
    if request_written && allow_graceful_stop {
        let deadline = Instant::now() + Duration::from_millis(RALPH_GRACEFUL_STOP_TIMEOUT_MS);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    return;
                }
                Ok(None) => thread::sleep(Duration::from_millis(DESKTOP_TASK_WAIT_POLL_MS)),
                Err(_) => break,
            }
        }
    }

    let _ = child.terminate_and_reap();
}

fn parse_ralph_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout)
        .map_err(|error| format!("Failed to parse the Ralph CLI JSON response: {error}."))
}

fn read_ralph_stdout_with_limit(
    stdout: impl io::Read,
    capture_limit_bytes: usize,
) -> Result<String, String> {
    let output = read_bounded_stream_text_with_limit(stdout, "stdout", capture_limit_bytes)?;

    if output.ends_with(SUBPROCESS_OUTPUT_TRUNCATED_MARKER) {
        return Err(
            "The Ralph CLI response is too large to display. The saved Ralph data is intact; inspect its artifact files instead."
                .to_string(),
        );
    }

    Ok(output)
}

fn read_ralph_stdout(stdout: impl io::Read) -> Result<String, String> {
    read_ralph_stdout_with_limit(stdout, RALPH_RESPONSE_CAPTURE_LIMIT_BYTES)
}

fn format_ralph_command_failure(stderr: &str) -> String {
    let diagnostic = format_command_failure(stderr, "");

    serde_json::from_str::<Value>(&diagnostic)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(str::to_string))
        .filter(|message| !message.trim().is_empty())
        .unwrap_or(diagnostic)
}

fn finish_ralph_command_response(
    status_success: bool,
    stdout: &str,
    stderr: &str,
) -> Result<Value, String> {
    match parse_ralph_command_response(stdout) {
        Ok(response) => Ok(response),
        Err(error) if status_success => Err(error),
        Err(_) => Err(format!(
            "The Ralph CLI command failed. {}",
            format_ralph_command_failure(stderr)
        )),
    }
}

fn finish_cancelled_ralph_command_response(
    stdout: &str,
    stderr: &str,
    run_id: Option<&str>,
) -> Result<Value, String> {
    if let Ok(response) = parse_ralph_command_response(stdout) {
        if let Some(run_id) = run_id {
            validate_ralph_run_response(&response, run_id)?;
        }
        return Ok(response);
    }
    let diagnostic = format_command_failure(stderr, "");
    if diagnostic == "The shared CLI exited without additional diagnostics." {
        return Err("The Ralph CLI command was cancelled.".to_string());
    }
    Err(format!("The Ralph CLI command was cancelled. {diagnostic}"))
}

fn finish_ralph_command_attempt(
    status: ExitStatus,
    output: Result<(String, String), String>,
    run_id: Option<&str>,
    interrupted_child: &mut bool,
) -> Result<Value, String> {
    let response = output
        .and_then(|(stdout, stderr)| {
            finish_ralph_command_response(status.success(), &stdout, &stderr)
        })
        .and_then(|response| {
            if let Some(run_id) = run_id {
                validate_ralph_run_response(&response, run_id)?;
            }
            Ok(response)
        })
        .map_err(|reason| format!("{reason} Exit status: {status}."));
    *interrupted_child = response.is_err() && status.code() != Some(130);
    response
}

fn validate_ralph_run_response(response: &Value, run_id: &str) -> Result<(), String> {
    let run = &response["run"];
    let valid = run.is_object()
        && matches!(
            run["status"].as_str(),
            Some("running" | "completed" | "crashed" | "blocked" | "stopped" | "waiting-for-input")
        )
        && run["flow"].is_string()
        && run["summary"].is_string()
        && run["validation"]["valid"].is_boolean()
        && run["validation"]["errors"].is_array()
        && run["validation"]["warnings"].is_array()
        && [
            "events",
            "blockResults",
            "missingVariables",
            "unknownVariables",
        ]
        .iter()
        .all(|field| run[*field].is_array())
        && run
            .get("runId")
            .is_none_or(|id| id.as_str() == Some(run_id));
    if !valid {
        return Err(format!(
            "The Ralph CLI did not return a valid result for run `{run_id}`."
        ));
    }
    Ok(())
}

fn normalize_ralph_flow_scope(scope: Option<&str>) -> Result<Option<String>, String> {
    let normalized_scope = scope.map(str::trim).filter(|value| !value.is_empty());

    match normalized_scope {
        Some("workspace" | "user") => Ok(normalized_scope.map(str::to_string)),
        Some(value) => Err(format!(
            "Expected Ralph flow scope to be `workspace` or `user`, got `{value}`."
        )),
        None => Ok(None),
    }
}

fn stop_ralph_cli_after_wait_error(
    error: io::Error,
    child: &mut SupervisedChild,
    stdout_worker: JoinHandle<Result<String, String>>,
    stderr_worker: JoinHandle<Result<Vec<String>, String>>,
    payload_paths: &[PathBuf],
) -> String {
    let child_cleanup = child.terminate_and_reap();
    let cleanup_result = join_cli_output_and_cleanup(stdout_worker, stderr_worker, None);
    cleanup_temporary_files(payload_paths);
    let message = format!("Failed to wait for the Ralph CLI to finish: {error}");
    let message = match child_cleanup {
        Ok(_) => message,
        Err(cleanup_error) => {
            format!("{message}. Additionally failed to stop the Ralph CLI: {cleanup_error}")
        }
    };

    match cleanup_result {
        Ok(_) => message,
        Err(cleanup_error) => {
            format!("{message}. Additionally failed to collect Ralph CLI output during cleanup: {cleanup_error}")
        }
    }
}

pub(super) fn execute_ralph_command(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: RalphCommandRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<Value, String> {
    supervise_ralph_command(
        &request.arguments,
        || cancel_flag.load(Ordering::SeqCst),
        |arguments, run_id| {
            let mut interrupted_child = false;
            let result = execute_ralph_command_attempt(
                app_handle.clone(),
                window_label.clone(),
                RalphCommandRequest {
                    workspace_root: request.workspace_root.clone(),
                    arguments: arguments.to_vec(),
                    task_id: request.task_id.clone(),
                },
                cancel_flag.clone(),
                run_id,
                &mut interrupted_child,
            );
            let retry_reason = match (&result, run_id) {
                (Ok(response), Some(id))
                    if response["run"]["status"] == "crashed"
                        && response["run"]["runId"] == id
                        && response["run"]["checkpoint"].is_object() =>
                {
                    response["run"]["summary"].as_str().map(str::to_string)
                }
                (Err(reason), Some(_)) if interrupted_child => Some(reason.clone()),
                _ => None,
            };
            if let (Some(reason), Some(id)) = (&retry_reason, run_id) {
                if !cancel_flag.load(Ordering::SeqCst) {
                    let mut inspection_interrupted = false;
                    let inspection = execute_ralph_command_attempt(
                        app_handle.clone(),
                        window_label.clone(),
                        RalphCommandRequest {
                            workspace_root: request.workspace_root.clone(),
                            arguments: recovery_inspection_arguments(&request.arguments, id),
                            task_id: request.task_id.clone(),
                        },
                        cancel_flag.clone(),
                        None,
                        &mut inspection_interrupted,
                    );
                    match inspection.and_then(|detail| reconcile_ralph_command_response(&detail, id)) {
                        Ok(Some(response)) => return RalphCommandAttempt { result: Ok(response), retry_reason: None },
                        Ok(None) => {},
                        Err(error) => return RalphCommandAttempt {
                            result: Err(format!("{reason}\nFailed to inspect the saved Ralph run before recovery: {error}")),
                            retry_reason: None,
                        },
                    }
                }
            }
            RalphCommandAttempt {
                result,
                retry_reason,
            }
        },
        || {
            emit_progress_event(
                &app_handle,
                &window_label,
                request.task_id.as_deref(),
                create_bridge_progress(
                    "resume",
                    Some("machdoch"),
                    "resolving-context",
                    "Recovering interrupted Ralph run.",
                    true,
                ),
            );
        },
    )
}

fn reconcile_ralph_command_response(detail: &Value, run_id: &str) -> Result<Option<Value>, String> {
    let record = &detail["record"];
    if record["id"] != run_id {
        return Err("The saved Ralph recovery record belongs to another run.".to_string());
    }
    if !matches!(
        record["status"].as_str(),
        Some("completed" | "stopped" | "waiting-for-input" | "blocked")
    ) {
        return Ok(None);
    }
    let mut run = serde_json::Map::new();
    for key in [
        "status",
        "summary",
        "outcome",
        "progress",
        "autonomy",
        "durability",
        "runWorktree",
        "integration",
        "checkpoint",
        "events",
        "validation",
    ] {
        run.insert(key.to_string(), record[key].clone());
    }
    let blocks = record["blockResults"]
        .as_array()
        .ok_or_else(|| "The saved Ralph run has no block results.".to_string())?;
    run.insert(
        "blockResults".to_string(),
        serde_json::json!(blocks
            .iter()
            .map(|block| serde_json::json!({
                "blockId": block["blockId"],
                "output": block["output"],
                "status": block["status"],
                "attempt": block["attempt"],
                "summary": block["summary"],
                "error": block["error"],
                "execution": block["executionStatus"].as_str().map(|status| serde_json::json!({
                    "status": status,
                    "summary": block["summary"],
                    "reason": block["reason"],
                })),
            }))
            .collect::<Vec<_>>()),
    );
    run.insert("runId".to_string(), record["id"].clone());
    run.insert("flow".to_string(), record["flowId"].clone());
    run.insert("missingVariables".to_string(), serde_json::json!([]));
    run.insert("unknownVariables".to_string(), serde_json::json!([]));
    run.insert(
        "pendingInput".to_string(),
        record["checkpoint"]["pendingInput"].clone(),
    );
    let response = serde_json::json!({
        "scope": detail["scope"],
        "run": run,
        "runRecordPath": detail["path"],
        "runLogPath": record["logPaths"]["simpleMarkdownPath"],
        "traceLogPath": record["logPaths"]["traceJsonlPath"],
    });
    validate_ralph_run_response(&response, run_id)?;
    Ok(Some(response))
}

fn execute_ralph_command_attempt(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: RalphCommandRequest,
    cancel_flag: Arc<AtomicBool>,
    run_id: Option<&str>,
    interrupted_child: &mut bool,
) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let payload_workspace_root = normalized_workspace_root.clone();
    let task_id = normalize_task_id(request.task_id.as_deref());
    let progress_task = request
        .arguments
        .first()
        .map(String::as_str)
        .unwrap_or("ralph")
        .to_string();
    let timeout_ms = ralph_command_timeout_ms(&progress_task);
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "ralph".to_string(),
    ];
    let (arguments, mut payload_paths) =
        rewrite_ralph_payload_arguments(payload_workspace_root.as_str(), request.arguments)?;
    let cancellation_path = create_ralph_cancel_path();
    payload_paths.push(cancellation_path.clone());
    let allow_graceful_stop = matches!(progress_task.as_str(), "run" | "resume");

    for argument in arguments {
        let normalized = argument.trim();

        if !normalized.is_empty() {
            cli_args.push(normalized.to_string());
        }
    }

    let mut cli_command = match crate::shared_cli::create_shared_cli_command(&cli_args) {
        Ok(command) => command,
        Err(error) => {
            cleanup_temporary_files(&payload_paths);
            return Err(error);
        }
    };
    let media_bridge = if progress_task == "snapshot" {
        None
    } else {
        match RalphMediaBridge::create() {
            Ok(bridge) => Some(bridge),
            Err(error) => {
                cleanup_temporary_files(&payload_paths);
                return Err(error);
            }
        }
    };
    if let Some(bridge) = &media_bridge {
        bridge.configure_command(&mut cli_command.command);
    }
    cli_command
        .command
        .env(RALPH_CANCEL_PATH_ENV, &cancellation_path);
    if progress_task == "run" {
        if let Some(run_id) = run_id {
            cli_command.command.env(RALPH_RUN_ID_ENV, run_id);
        }
    }
    if let Some(credentials) = app_handle
        .state::<crate::workspace_run::WorkspaceRunState>()
        .control_credentials()
    {
        cli_command
            .command
            .env("MACHDOCH_RUN_CONTROL_ADDRESS", credentials.address)
            .env("MACHDOCH_RUN_CONTROL_TOKEN", credentials.token)
            .env(
                "MACHDOCH_WORKSPACE_PRESENCE_TOKEN",
                credentials.presence_token,
            );
    }

    cli_command
        .command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match SupervisedChild::spawn(&mut cli_command.command) {
        Ok(child) => child,
        Err(SupervisedChildSpawnError::Spawn(error)) => {
            cleanup_temporary_files(&payload_paths);
            return Err(format!(
                "Failed to launch the Ralph CLI. {} {error}",
                crate::shared_cli::cli_runtime_error_hint()
            ));
        }
        Err(SupervisedChildSpawnError::Isolation(error)) => {
            cleanup_temporary_files(&payload_paths);
            return Err(error);
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            request_ralph_cli_stop(
                &mut child,
                &cancellation_path,
                "Desktop could not attach to Ralph stdout; finalize the run before stopping.",
                allow_graceful_stop,
            );
            cleanup_temporary_files(&payload_paths);
            return Err("The Ralph CLI did not expose a stdout stream.".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            request_ralph_cli_stop(
                &mut child,
                &cancellation_path,
                "Desktop could not attach to Ralph stderr; finalize the run before stopping.",
                allow_graceful_stop,
            );
            cleanup_temporary_files(&payload_paths);
            return Err("The Ralph CLI did not expose a stderr stream.".to_string());
        }
    };

    let progress_app_handle = app_handle.clone();
    let progress_window_label = window_label.clone();
    let progress_task_id = task_id.clone();
    let stdout_worker = thread::spawn(move || read_ralph_stdout(stdout));
    let stderr_app_handle = app_handle.clone();
    let stderr_worker =
        thread::spawn(move || read_stderr(stderr, stderr_app_handle, window_label, task_id));

    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Err(error) => {
                *interrupted_child = true;
                return Err(stop_ralph_cli_after_wait_error(
                    error,
                    &mut child,
                    stdout_worker,
                    stderr_worker,
                    &payload_paths,
                ));
            }
            Ok(None) => {
                if let Err(error) = media_bridge
                    .as_ref()
                    .map(|bridge| bridge.service_pending_request(&app_handle, &workspace_path))
                    .transpose()
                {
                    request_ralph_cli_stop(
                        &mut child,
                        &cancellation_path,
                        "Desktop media handling failed; finalize the Ralph run before stopping.",
                        allow_graceful_stop,
                    );
                    let cleanup_result =
                        join_cli_output_and_cleanup(stdout_worker, stderr_worker, None);
                    cleanup_temporary_files(&payload_paths);
                    return match cleanup_result {
                        Ok(_) => Err(error),
                        Err(cleanup_error) => Err(format!(
                            "{error}. Additionally failed to collect Ralph CLI output: {cleanup_error}"
                        )),
                    };
                }
                if cancel_flag.load(Ordering::SeqCst) {
                    emit_progress_event(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        create_bridge_progress(
                            &progress_task,
                            Some("machdoch"),
                            "cancelled",
                            "Cancelled by user; stopping the Ralph command.",
                            false,
                        ),
                    );

                    request_ralph_cli_stop(
                        &mut child,
                        &cancellation_path,
                        "Desktop cancellation requested by the user.",
                        allow_graceful_stop,
                    );

                    let (stdout_text, stderr_text) =
                        match join_cli_output_and_cleanup(stdout_worker, stderr_worker, None) {
                            Ok(output) => output,
                            Err(error) => {
                                cleanup_temporary_files(&payload_paths);
                                return Err(error);
                            }
                        };
                    cleanup_temporary_files(&payload_paths);
                    return finish_cancelled_ralph_command_response(
                        &stdout_text,
                        &stderr_text,
                        run_id,
                    );
                }

                if let Some(timeout_ms) =
                    timeout_ms.filter(|limit| started_at.elapsed() >= Duration::from_millis(*limit))
                {
                    emit_progress_event(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        create_bridge_progress(
                            &progress_task,
                            Some("machdoch"),
                            "cancelled",
                            "The Ralph command exceeded the desktop Ralph timeout; stopping it.",
                            false,
                        ),
                    );

                    request_ralph_cli_stop(
                        &mut child,
                        &cancellation_path,
                        "Desktop Ralph execution exceeded its safety timeout.",
                        allow_graceful_stop,
                    );

                    let (stdout_text, stderr_text) =
                        match join_cli_output_and_cleanup(stdout_worker, stderr_worker, None) {
                            Ok(output) => output,
                            Err(error) => {
                                cleanup_temporary_files(&payload_paths);
                                return Err(error);
                            }
                        };
                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);
                    cleanup_temporary_files(&payload_paths);

                    return Err(format!(
                        "The Ralph CLI exceeded the desktop Ralph timeout of {} and was stopped. {}",
                        format_timeout_duration(timeout_ms),
                        failure_tail
                    ));
                }

                thread::sleep(Duration::from_millis(DESKTOP_TASK_WAIT_POLL_MS));
            }
        }
    };
    let output = join_cli_output_and_cleanup(stdout_worker, stderr_worker, None);
    cleanup_temporary_files(&payload_paths);

    finish_ralph_command_attempt(status, output, run_id, interrupted_child)
}

pub(super) fn resolve_ralph_flow_path_for_open(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: OpenRalphFlowPathRequest,
) -> Result<PathBuf, String> {
    let normalized_flow = request.flow.trim();

    if normalized_flow.is_empty() {
        return Err("Expected a Ralph flow id or alias to open.".to_string());
    }

    let normalized_scope = normalize_ralph_flow_scope(request.scope.as_deref())?;
    let mut arguments = vec!["show".to_string(), normalized_flow.to_string()];

    if let Some(scope) = normalized_scope {
        arguments.push("--scope".to_string());
        arguments.push(scope);
    }

    let command_response = execute_ralph_command(
        app_handle,
        window_label,
        RalphCommandRequest {
            workspace_root: request.workspace_root,
            arguments,
            task_id: None,
        },
        Arc::new(AtomicBool::new(false)),
    )?;
    let resolved_path = command_response
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "The Ralph CLI response did not include a flow path.".to_string())?;
    let candidate_path = PathBuf::from(resolved_path);

    if !candidate_path.is_absolute() {
        return Err("The Ralph CLI returned a non-absolute flow path.".to_string());
    }

    candidate_path
        .canonicalize()
        .map_err(|error| format!("Unable to resolve Ralph flow path `{resolved_path}`: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        io::{self, Cursor},
        process::{Command, ExitStatus, Stdio},
        thread,
        time::{Duration, Instant},
    };

    use serde_json::json;

    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;

    use super::{
        create_ralph_cancel_path, finish_cancelled_ralph_command_response,
        finish_ralph_command_attempt, finish_ralph_command_response, normalize_ralph_flow_scope,
        parse_ralph_command_response, ralph_command_timeout_ms, read_ralph_stdout,
        read_ralph_stdout_with_limit, reconcile_ralph_command_response, request_ralph_cli_stop,
        stop_ralph_cli_after_wait_error, RALPH_CANCEL_PATH_ENV,
    };
    use crate::child_process::{ChildCleanupKind, SupervisedChild};
    use crate::desktop_task::process::SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES;

    const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_RALPH_LIFECYCLE_TEST_MODE";

    #[test]
    fn recovery_reconciles_saved_terminal_outcomes_without_replaying_them() {
        for status in ["completed", "stopped", "waiting-for-input", "blocked"] {
            let detail = json!({
                "scope": "workspace", "path": "owned/run.json",
                "record": { "id": "saved-run", "flowId": "flow", "status": status, "summary": "Saved outcome", "events": [], "validation": { "valid": true, "errors": [], "warnings": [] }, "checkpoint": { "pendingInput": { "id": "input" } }, "blockResults": [{ "blockId": "work", "output": "SUCCESS", "status": "success", "attempt": 1, "summary": "Saved work", "executionStatus": "completed", "reason": "Proof", "instructionDelivery": { "canonical": "private-guidance" } }] }
            });
            let reconciled = reconcile_ralph_command_response(&detail, "saved-run")
                .unwrap()
                .unwrap();
            assert_eq!(reconciled["run"]["runId"], "saved-run");
            assert_eq!(reconciled["run"]["status"], status);
            assert_eq!(reconciled["run"]["pendingInput"]["id"], "input");
            assert_eq!(reconciled["runRecordPath"], "owned/run.json");
            assert_eq!(
                reconciled["run"]["blockResults"][0]["execution"]["status"],
                "completed"
            );
            assert!(reconciled["run"]["blockResults"][0]
                .get("instructionDelivery")
                .is_none());
        }
        let resumable = json!({ "record": { "id": "saved-run", "status": "crashed" } });
        assert!(reconcile_ralph_command_response(&resumable, "saved-run")
            .unwrap()
            .is_none());
        assert!(reconcile_ralph_command_response(&resumable, "foreign-run").is_err());
    }

    #[test]
    fn cancelled_run_retains_its_structured_checkpoint_response() {
        let response =
            json!({ "run": { "status": "stopped", "checkpoint": { "currentBlockId": "write" } } });
        assert_eq!(
            finish_cancelled_ralph_command_response(&response.to_string(), "", None).unwrap(),
            response
        );
    }

    #[test]
    fn recovery_rejects_incomplete_saved_terminal_results() {
        let detail = json!({"record": {"id": "saved-run", "status": "completed", "blockResults": [], "private": "private-content"}});
        let error = reconcile_ralph_command_response(&detail, "saved-run")
            .expect_err("an incomplete saved result should not be returned to the UI");
        assert!(error.contains("saved-run"));
        assert!(!error.contains("private-content"));
    }

    #[test]
    fn cancelled_command_does_not_expose_unparsed_stdout() {
        let error =
            finish_cancelled_ralph_command_response("internal partial run payload", "", None)
                .unwrap_err();
        assert_eq!(error, "The Ralph CLI command was cancelled.");
    }

    #[test]
    fn cancelled_command_rejects_malformed_run_results() {
        let error = finish_cancelled_ralph_command_response("null", "", Some("cancelled-run"))
            .expect_err("cancelled run responses should meet the run result contract");
        assert!(error.contains("cancelled-run"));
    }

    #[test]
    fn ralph_status_queries_do_not_share_the_execution_timeout() {
        for action in ["snapshot", "list", "runs", "run-detail"] {
            assert_eq!(ralph_command_timeout_ms(action), Some(60_000));
        }
        for action in ["run", "resume"] {
            assert_eq!(ralph_command_timeout_ms(action), None);
        }
        for action in ["create", "interview", "save", "delete"] {
            assert_eq!(
                ralph_command_timeout_ms(action),
                Some(crate::desktop_task::RALPH_COMMAND_TIMEOUT_MS)
            );
        }
    }

    #[test]
    fn ralph_lifecycle_test_entrypoint() {
        if env::var(TEST_CHILD_MODE_ENV).as_deref() != Ok("cooperative") {
            return;
        }
        let cancellation_path = env::var_os(RALPH_CANCEL_PATH_ENV)
            .map(std::path::PathBuf::from)
            .expect("Ralph cancellation path should be configured");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cancellation_path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            cancellation_path.exists(),
            "cancellation request should arrive"
        );
    }

    #[test]
    fn ralph_stop_preserves_cooperative_cancellation_window() {
        let cancellation_path = create_ralph_cancel_path();
        let mut command = Command::new(env::current_exe().expect("test executable should resolve"));
        command
            .arg("--exact")
            .arg("desktop_task::ralph::tests::ralph_lifecycle_test_entrypoint")
            .arg("--nocapture")
            .env(TEST_CHILD_MODE_ENV, "cooperative")
            .env(RALPH_CANCEL_PATH_ENV, &cancellation_path);
        let mut child =
            SupervisedChild::spawn(&mut command).expect("cooperative Ralph child should start");
        request_ralph_cli_stop(&mut child, &cancellation_path, "test cancellation", true);

        assert!(child
            .try_wait()
            .expect("cooperatively stopped child should report its exit status")
            .is_some_and(|status| status.success()));
        assert_eq!(
            child
                .terminate_and_reap()
                .expect("cooperatively stopped child should already be reaped")
                .kind,
            ChildCleanupKind::AlreadyExited
        );
        fs::remove_file(&cancellation_path).expect("test cancellation file should be removed");
    }

    #[test]
    fn wait_error_cleanup_does_not_issue_a_user_cancellation() {
        let cancellation_path = create_ralph_cancel_path();
        let mut command = Command::new(env::current_exe().expect("test executable should resolve"));
        command
            .arg("--exact")
            .arg("desktop_task::ralph::tests::ralph_lifecycle_test_entrypoint")
            .arg("--nocapture")
            .env(TEST_CHILD_MODE_ENV, "cooperative")
            .env(RALPH_CANCEL_PATH_ENV, &cancellation_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = SupervisedChild::spawn(&mut command).expect("Ralph child should start");
        let stdout = child.stdout.take().expect("stdout should be piped");
        let stderr = child.stderr.take().expect("stderr should be piped");
        let stdout_worker = thread::spawn(move || read_ralph_stdout(stdout));
        let stderr_worker = thread::spawn(move || read_ralph_stdout(stderr).map(|text| vec![text]));
        let error = stop_ralph_cli_after_wait_error(
            io::Error::other("Lost wait handle"),
            &mut child,
            stdout_worker,
            stderr_worker,
            &[],
        );

        assert!(error.contains("Lost wait handle"));
        assert!(!cancellation_path.exists());
        assert_eq!(
            child
                .terminate_and_reap()
                .expect("child should be reaped")
                .kind,
            ChildCleanupKind::AlreadyExited,
        );
    }

    #[test]
    fn ralph_flow_scope_accepts_only_known_scopes() {
        assert_eq!(
            normalize_ralph_flow_scope(Some(" workspace ")).expect("scope should normalize"),
            Some("workspace".to_string())
        );
        assert_eq!(
            normalize_ralph_flow_scope(Some("")).expect("blank scope should normalize"),
            None
        );
        assert!(normalize_ralph_flow_scope(Some("project")).is_err());
    }

    #[test]
    fn ralph_parse_error_does_not_expose_the_unprocessed_response() {
        let response = "not-json".repeat(20 * 1024);
        let error = parse_ralph_command_response(&response).expect_err("invalid JSON should fail");

        assert!(error.contains("Failed to parse the Ralph CLI JSON response"));
        assert!(!error.contains("Output:"));
        assert!(!error.contains(&response[..1024]));
    }

    #[test]
    fn ralph_stdout_preserves_large_terminal_run_responses() {
        for (run_status, outcome_status, status_success) in [
            ("completed", "succeeded", true),
            ("blocked", "deferred", false),
            ("blocked", "blocked", false),
            ("crashed", "failed", false),
        ] {
            let response = json!({
                "run": {
                    "status": run_status,
                    "outcome": { "status": outcome_status },
                    "detail": "x".repeat(SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES + 1024),
                }
            })
            .to_string();
            let stdout = read_ralph_stdout(Cursor::new(response))
                .expect("valid Ralph JSON above the shared diagnostic limit should be retained");
            let parsed = finish_ralph_command_response(status_success, &stdout, "")
                .expect("terminal Ralph outcomes should remain structured responses");

            assert_eq!(parsed["run"]["status"], run_status);
            assert_eq!(parsed["run"]["outcome"]["status"], outcome_status);
        }
    }

    #[test]
    fn ralph_stdout_limit_returns_a_recoverable_error_without_partial_output() {
        let error = read_ralph_stdout_with_limit(Cursor::new(vec![b'x'; 256]), 128)
            .expect_err("oversized Ralph output should not be parsed as partial JSON");

        assert!(error.contains("too large to display"));
        assert!(error.contains("saved Ralph data is intact"));
        assert!(!error.contains(&"x".repeat(64)));
    }

    #[test]
    fn output_capture_failure_after_successful_exit_requires_saved_run_inspection() {
        let output = read_ralph_stdout_with_limit(Cursor::new(vec![b'x'; 256]), 128)
            .map(|stdout| (stdout, String::new()));
        let mut interrupted = false;
        let error =
            finish_ralph_command_attempt(ExitStatus::from_raw(0), output, None, &mut interrupted)
                .unwrap_err();

        assert!(interrupted);
        assert!(error.contains("saved Ralph data is intact"));
        assert!(!error.contains(&"x".repeat(64)));
    }

    #[test]
    fn cancellation_exit_does_not_retry_an_output_failure() {
        #[cfg(unix)]
        let status = ExitStatus::from_raw(130 << 8);
        #[cfg(windows)]
        let status = ExitStatus::from_raw(130);
        let mut interrupted = false;
        let error = finish_ralph_command_attempt(
            status,
            Err("Output stream closed".to_string()),
            None,
            &mut interrupted,
        )
        .unwrap_err();

        assert!(!interrupted);
        assert!(error.contains("Output stream closed"));
    }

    #[test]
    fn malformed_run_results_require_inspection_without_exposing_the_payload() {
        for response in [
            json!(null),
            json!({"run": {"status": "completed", "private": "private-content"}}),
            json!({"run": {"runId": "foreign-run", "status": "completed", "flow": "flow", "summary": "private-content", "validation": {"valid": true, "errors": [], "warnings": []}, "events": [], "blockResults": [], "missingVariables": [], "unknownVariables": []}}),
            json!({"run": {"runId": "saved-run", "status": "completed", "flow": "flow", "summary": "private-content", "validation": {}, "events": [], "blockResults": [], "missingVariables": [], "unknownVariables": []}}),
        ] {
            let mut interrupted = false;
            let error = finish_ralph_command_attempt(
                ExitStatus::from_raw(0),
                Ok((response.to_string(), String::new())),
                Some("saved-run"),
                &mut interrupted,
            )
            .unwrap_err();
            assert!(interrupted);
            assert!(error.contains("saved-run"));
            assert!(!error.contains("private-content"));
        }
    }

    #[test]
    fn pre_execution_validation_results_can_omit_the_run_identity() {
        let response = json!({"run": {"status": "blocked", "flow": "flow", "summary": "Missing required variable", "validation": {"valid": true, "errors": [], "warnings": []}, "events": [], "blockResults": [], "missingVariables": ["goal"], "unknownVariables": []}});
        let mut interrupted = false;
        assert_eq!(
            finish_ralph_command_attempt(
                ExitStatus::from_raw(0),
                Ok((response.to_string(), String::new())),
                Some("saved-run"),
                &mut interrupted,
            )
            .unwrap(),
            response,
        );
        assert!(!interrupted);
    }

    #[test]
    fn ralph_cli_failures_use_structured_stderr_without_exposing_stdout() {
        let error = finish_ralph_command_response(
            false,
            "partial unprocessed response",
            r#"{"error":"Ralph flow CAS conflict. Refresh and try again.","exitCode":1}"#,
        )
        .expect_err("a command failure without a structured response should fail");

        assert_eq!(
            error,
            "The Ralph CLI command failed. Ralph flow CAS conflict. Refresh and try again."
        );
        assert!(!error.contains("partial unprocessed response"));
    }

    #[test]
    fn ralph_cancel_paths_are_unique_temporary_files() {
        let first = create_ralph_cancel_path();
        let second = create_ralph_cancel_path();

        assert_ne!(first, second);
        assert!(first.starts_with(std::env::temp_dir()));
        assert_eq!(
            first.extension().and_then(|value| value.to_str()),
            Some("request")
        );
    }
}
