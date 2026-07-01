use std::{
    path::PathBuf,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::Value;

use crate::runtime_snapshot::resolve_workspace_root_path;

use super::{
    diagnostics::{format_command_failure, format_timeout_duration},
    payload::{cleanup_temporary_files, rewrite_ralph_payload_arguments},
    process::{
        create_desktop_task_activity, join_cli_output_and_cleanup, read_stderr, read_stdout,
        terminate_child_process_tree,
    },
    progress::{create_bridge_progress, emit_progress_event},
    registry::normalize_task_id,
    OpenRalphFlowPathRequest, RalphCommandRequest, DESKTOP_TASK_WAIT_POLL_MS,
    RALPH_COMMAND_TIMEOUT_MS,
};

#[cfg(target_os = "windows")]
use super::process::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

fn parse_ralph_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!("Failed to parse the Ralph CLI JSON response: {error}. Output: {trimmed_stdout}")
    })
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

pub(super) fn execute_ralph_command(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: RalphCommandRequest,
    cancel_flag: Arc<AtomicBool>,
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
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "ralph".to_string(),
    ];
    let (arguments, payload_paths) =
        rewrite_ralph_payload_arguments(payload_workspace_root.as_str(), request.arguments)?;

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

    cli_command
        .command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cli_command
            .command
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    #[cfg(unix)]
    {
        cli_command.command.process_group(0);
    }

    let mut child = match cli_command.command.spawn() {
        Ok(child) => child,
        Err(error) => {
            cleanup_temporary_files(&payload_paths);
            return Err(format!(
                "Failed to launch the Ralph CLI. {} {error}",
                crate::shared_cli::cli_runtime_error_hint()
            ));
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            cleanup_temporary_files(&payload_paths);
            return Err("The Ralph CLI did not expose a stdout stream.".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            cleanup_temporary_files(&payload_paths);
            return Err("The Ralph CLI did not expose a stderr stream.".to_string());
        }
    };

    let progress_app_handle = app_handle.clone();
    let progress_window_label = window_label.clone();
    let progress_task_id = task_id.clone();
    let activity = create_desktop_task_activity();
    let stdout_worker = thread::spawn(move || read_stdout(stdout));
    let stderr_worker =
        thread::spawn(move || read_stderr(stderr, app_handle, window_label, task_id, activity));

    let started_at = Instant::now();
    let status = loop {
        match child
            .try_wait()
            .map_err(|error| format!("Failed to wait for the Ralph CLI to finish: {error}"))?
        {
            Some(status) => break status,
            None => {
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
                            true,
                        ),
                    );

                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

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

                    if failure_tail == "The shared CLI exited without additional diagnostics." {
                        return Err("The Ralph CLI command was cancelled.".to_string());
                    }

                    return Err(format!(
                        "The Ralph CLI command was cancelled. {}",
                        failure_tail
                    ));
                }

                if started_at.elapsed() >= Duration::from_millis(RALPH_COMMAND_TIMEOUT_MS) {
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

                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

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
                        format_timeout_duration(RALPH_COMMAND_TIMEOUT_MS),
                        failure_tail
                    ));
                }

                thread::sleep(Duration::from_millis(DESKTOP_TASK_WAIT_POLL_MS));
            }
        }
    };
    let (stdout_text, stderr_text) =
        match join_cli_output_and_cleanup(stdout_worker, stderr_worker, None) {
            Ok(output) => output,
            Err(error) => {
                cleanup_temporary_files(&payload_paths);
                return Err(error);
            }
        };
    cleanup_temporary_files(&payload_paths);

    if !status.success() {
        return Err(format!(
            "The Ralph CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_ralph_command_response(&stdout_text)
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
    use super::normalize_ralph_flow_scope;

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
}
