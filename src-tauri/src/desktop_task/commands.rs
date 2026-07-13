use std::{
    io,
    path::PathBuf,
    process::Child,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::runtime_snapshot::{normalize_optional_string, resolve_workspace_root_path};

use super::{
    diagnostics::{format_command_failure, format_diagnostic_snippet, format_timeout_duration},
    payload::{
        build_cli_args, cleanup_temporary_file, enrich_ui_control_conversation_context,
        write_conversation_context_file, CliCommandOptions,
    },
    process::{
        assign_child_process_to_kill_on_close_job, create_desktop_task_activity,
        desktop_task_activity_elapsed, join_cli_output_and_cleanup, read_stderr, read_stdout,
        terminate_child_process_tree,
    },
    progress::{create_bridge_progress, emit_progress_event},
    DesktopTaskRunRequest, DesktopTaskRunResponse, DESKTOP_TASK_ABSOLUTE_TIMEOUT_MS,
    DESKTOP_TASK_TIMEOUT_MS, DESKTOP_TASK_WAIT_POLL_MS,
};

#[cfg(target_os = "windows")]
use super::process::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

fn parse_desktop_task_response(stdout: &str) -> Result<DesktopTaskRunResponse, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<DesktopTaskRunResponse>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the shared CLI JSON response: {error}. Output: {}",
            format_diagnostic_snippet(trimmed_stdout)
        )
    })
}

fn stop_shared_cli_after_wait_error(
    error: io::Error,
    child: &mut Child,
    stdout_worker: JoinHandle<Result<String, String>>,
    stderr_worker: JoinHandle<Result<Vec<String>, String>>,
    conversation_context_path: Option<&PathBuf>,
) -> String {
    terminate_child_process_tree(child);
    let _ = child.wait();

    let cleanup_result =
        join_cli_output_and_cleanup(stdout_worker, stderr_worker, conversation_context_path);
    let message = format!("Failed to wait for the shared CLI to finish: {error}");

    match cleanup_result {
        Ok(_) => message,
        Err(cleanup_error) => {
            format!("{message}. Additionally failed to collect shared CLI output during cleanup: {cleanup_error}")
        }
    }
}

pub(super) fn execute_desktop_task(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: DesktopTaskRunRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<DesktopTaskRunResponse, String> {
    let execution_started_at = Instant::now();
    let DesktopTaskRunRequest {
        workspace_root,
        task,
        mode,
        provider,
        model,
        reasoning,
        conversation_context,
        image_paths,
        task_id,
        session_id: _,
    } = request;
    let workspace_path = resolve_workspace_root_path(&workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();

    let normalized_task = task.trim();

    if normalized_task.is_empty() {
        return Err("Expected a non-empty task before running the desktop executor.".to_string());
    }

    let normalized_provider = normalize_optional_string(provider.as_deref());
    let normalized_mode = normalize_optional_string(mode.as_deref());
    let normalized_model = normalize_optional_string(model.as_deref());
    let normalized_reasoning = normalize_optional_string(reasoning.as_deref());
    let conversation_context = enrich_ui_control_conversation_context(conversation_context)?;
    let conversation_context_path = conversation_context
        .as_ref()
        .map(write_conversation_context_file)
        .transpose()?;

    let cli_args = build_cli_args(CliCommandOptions {
        workspace_root: &normalized_workspace_root,
        task: normalized_task,
        mode: normalized_mode.as_deref(),
        provider: normalized_provider.as_deref(),
        model: normalized_model.as_deref(),
        reasoning: normalized_reasoning.as_deref(),
        conversation_context_file: conversation_context_path.as_deref(),
        image_paths: image_paths.as_deref().unwrap_or(&[]),
    });
    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;

    cli_command
        .command
        .env(
            "MACHDOCH_DESKTOP_HOST_ELEVATED",
            if crate::desktop_shell::current_process_has_administrator_rights() {
                "true"
            } else {
                "false"
            },
        )
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

    let mut child = cli_command.command.spawn().map_err(|error| {
        cleanup_temporary_file(conversation_context_path.as_ref());

        format!(
            "Failed to launch the shared CLI. {} {error}",
            crate::shared_cli::cli_runtime_error_hint()
        )
    })?;
    let _child_job = assign_child_process_to_kill_on_close_job(&child).map_err(|error| {
        terminate_child_process_tree(&mut child);
        let _ = child.wait();
        cleanup_temporary_file(conversation_context_path.as_ref());
        error
    })?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            cleanup_temporary_file(conversation_context_path.as_ref());
            return Err(
                "The shared CLI did not expose a stdout stream for the desktop bridge.".to_string(),
            );
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            cleanup_temporary_file(conversation_context_path.as_ref());
            return Err(
                "The shared CLI did not expose a stderr stream for the desktop bridge.".to_string(),
            );
        }
    };
    let progress_app_handle = app_handle.clone();
    let progress_window_label = window_label.clone();
    let progress_task_id = task_id.clone();

    let activity = create_desktop_task_activity();
    let stderr_activity = activity.clone();
    let stdout_worker = thread::spawn(move || read_stdout(stdout));
    let stderr_worker = thread::spawn(move || {
        read_stderr(stderr, app_handle, window_label, task_id, stderr_activity)
    });

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Err(error) => {
                return Err(stop_shared_cli_after_wait_error(
                    error,
                    &mut child,
                    stdout_worker,
                    stderr_worker,
                    conversation_context_path.as_ref(),
                ));
            }
            Ok(None) => {
                if cancel_flag.load(Ordering::SeqCst) {
                    emit_progress_event(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        create_bridge_progress(
                            normalized_task,
                            normalized_mode.as_deref(),
                            "cancelled",
                            "Cancelled by user; stopping the task.",
                            false,
                        ),
                    );

                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

                    let (stdout_text, stderr_text) = join_cli_output_and_cleanup(
                        stdout_worker,
                        stderr_worker,
                        conversation_context_path.as_ref(),
                    )?;

                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);
                    return Err(format!("The task was cancelled. {}", failure_tail));
                }

                if desktop_task_activity_elapsed(&activity)
                    >= Duration::from_millis(DESKTOP_TASK_TIMEOUT_MS)
                {
                    emit_progress_event(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        create_bridge_progress(
                            normalized_task,
                            normalized_mode.as_deref(),
                            "cancelled",
                            "Execution exceeded the desktop safety timeout; stopping the task.",
                            false,
                        ),
                    );

                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

                    let (stdout_text, stderr_text) = join_cli_output_and_cleanup(
                        stdout_worker,
                        stderr_worker,
                        conversation_context_path.as_ref(),
                    )?;

                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);
                    return Err(format!(
                        "The shared CLI exceeded the desktop safety timeout of {} and was stopped. {}",
                        format_timeout_duration(DESKTOP_TASK_TIMEOUT_MS),
                        failure_tail
                    ));
                }

                if execution_started_at.elapsed()
                    >= Duration::from_millis(DESKTOP_TASK_ABSOLUTE_TIMEOUT_MS)
                {
                    emit_progress_event(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        create_bridge_progress(
                            normalized_task,
                            normalized_mode.as_deref(),
                            "cancelled",
                            "Execution exceeded the absolute desktop deadline; stopping the task.",
                            false,
                        ),
                    );

                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

                    let (stdout_text, stderr_text) = join_cli_output_and_cleanup(
                        stdout_worker,
                        stderr_worker,
                        conversation_context_path.as_ref(),
                    )?;
                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);

                    return Err(format!(
                        "The shared CLI exceeded the absolute desktop deadline of {} and was stopped. {}",
                        format_timeout_duration(DESKTOP_TASK_ABSOLUTE_TIMEOUT_MS),
                        failure_tail
                    ));
                }

                thread::sleep(Duration::from_millis(DESKTOP_TASK_WAIT_POLL_MS));
            }
        }
    };
    let (stdout_text, stderr_text) = join_cli_output_and_cleanup(
        stdout_worker,
        stderr_worker,
        conversation_context_path.as_ref(),
    )?;

    if !stdout_text.trim().is_empty() {
        if let Ok(response) = parse_desktop_task_response(&stdout_text) {
            return Ok(response);
        }
    }

    if !status.success() {
        return Err(format!(
            "The shared CLI could not complete the task. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_desktop_task_response(&stdout_text)
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        io::{self, Read},
        process::{Command, Stdio},
        thread,
    };

    use serde_json::json;

    use super::{parse_desktop_task_response, stop_shared_cli_after_wait_error};
    use crate::desktop_task::diagnostics::COMMAND_DIAGNOSTIC_TRUNCATED_MARKER;
    use crate::desktop_task::payload::write_conversation_context_file;

    const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_DESKTOP_TASK_WAIT_ERROR_TEST_CHILD_MODE";

    #[test]
    fn desktop_task_wait_error_cleanup_child_entrypoint() {
        if env::var(TEST_CHILD_MODE_ENV).as_deref() != Ok("hold-pipes") {
            return;
        }

        println!("child stdout before wait error cleanup");
        eprintln!("child stderr before wait error cleanup");
        loop {
            thread::park();
        }
    }

    #[test]
    fn wait_error_cleanup_removes_context_file_and_joins_output_workers() {
        let context_path = write_conversation_context_file(&json!({ "history": [] }))
            .expect("context file should be created");
        let mut command = Command::new(env::current_exe().expect("test executable should resolve"));

        command
            .arg("--exact")
            .arg("desktop_task::commands::tests::desktop_task_wait_error_cleanup_child_entrypoint")
            .arg("--nocapture")
            .env(TEST_CHILD_MODE_ENV, "hold-pipes")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().expect("test child should start");
        let mut stdout = child.stdout.take().expect("stdout should be piped");
        let mut stderr = child.stderr.take().expect("stderr should be piped");
        let stdout_worker = thread::spawn(move || {
            let mut output = String::new();
            stdout
                .read_to_string(&mut output)
                .map_err(|error| format!("stdout read failed: {error}"))?;

            Ok(output)
        });
        let stderr_worker = thread::spawn(move || {
            let mut output = String::new();
            stderr
                .read_to_string(&mut output)
                .map_err(|error| format!("stderr read failed: {error}"))?;

            Ok(output.lines().map(str::to_string).collect::<Vec<_>>())
        });

        let error = stop_shared_cli_after_wait_error(
            io::Error::new(io::ErrorKind::Other, "simulated wait failure"),
            &mut child,
            stdout_worker,
            stderr_worker,
            Some(&context_path),
        );

        assert!(error.contains("Failed to wait for the shared CLI to finish"));
        assert!(!context_path.exists());
        let _ = fs::remove_file(context_path);
    }

    #[test]
    fn desktop_task_parse_error_uses_bounded_output_snippet() {
        let error = parse_desktop_task_response(&"not-json".repeat(20 * 1024))
            .expect_err("invalid JSON should fail");

        assert!(error.contains("Failed to parse the shared CLI JSON response"));
        assert!(error.contains(COMMAND_DIAGNOSTIC_TRUNCATED_MARKER));
        assert!(error.len() < 18 * 1024);
    }
}
