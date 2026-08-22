use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicU8, Ordering},
    sync::Arc,
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::Manager as _;

use crate::{
    child_process::{SupervisedChild, SupervisedChildSpawnError},
    runtime_snapshot::{normalize_optional_string, resolve_workspace_root_path},
};

use super::{
    diagnostics::{format_command_failure, format_diagnostic_snippet, format_timeout_duration},
    payload::{
        build_cli_args, cleanup_temporary_file, enrich_ui_control_conversation_context,
        write_conversation_context_file, CliCommandOptions,
    },
    process::{
        create_desktop_task_activity, desktop_task_activity_elapsed, join_cli_output_and_cleanup,
        read_stderr, read_stdout,
    },
    progress::{create_bridge_progress, emit_progress_event},
    DesktopMediaAssetReference, DesktopTaskRunRequest, DesktopTaskRunResponse,
    DESKTOP_TASK_IDLE_TIMEOUT_MS, DESKTOP_TASK_TERMINATION_CANCELLED,
    DESKTOP_TASK_TERMINATION_IDLE_TIMEOUT, DESKTOP_TASK_WAIT_POLL_MS,
};

fn parse_desktop_task_response(stdout: &str) -> Result<DesktopTaskRunResponse, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<DesktopTaskRunResponse>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the shared CLI JSON response: {error}. Output: {}",
            format_diagnostic_snippet(trimmed_stdout)
        )
    })
}

fn is_expected_cancelled_desktop_task_response(
    exit_code: Option<i32>,
    response: &DesktopTaskRunResponse,
) -> bool {
    exit_code == Some(130)
        && response
            .execution
            .get("status")
            .and_then(serde_json::Value::as_str)
            == Some("cancelled")
}

fn resolve_media_asset_reference_paths(
    app_handle: &tauri::AppHandle,
    workspace_path: &Path,
    references: Vec<DesktopMediaAssetReference>,
) -> Result<Vec<String>, String> {
    if references.len() > 20 {
        return Err("A desktop task can attach at most 20 Media Studio assets.".to_string());
    }
    let mut seen_asset_ids = HashSet::new();
    let mut paths = Vec::with_capacity(references.len());
    for reference in references {
        if reference.source.trim() != "media-asset" {
            return Err("Media Studio attachment source must be `media-asset`.".to_string());
        }
        if reference.kind.trim() != "image" {
            return Err("Only Media Studio image assets can be attached to Chat.".to_string());
        }
        if reference
            .rendition
            .as_deref()
            .is_some_and(|rendition| rendition.trim() != "original")
        {
            return Err(
                "Chat model input currently requires the original Media Studio rendition."
                    .to_string(),
            );
        }
        if reference
            .display_name
            .as_deref()
            .is_some_and(|name| name.chars().count() > 256)
        {
            return Err("Media Studio attachment displayName exceeds 256 characters.".to_string());
        }
        let asset_id = reference.asset_id.trim();
        if asset_id.is_empty() || asset_id.chars().count() > 256 {
            return Err("Media Studio attachment assetId is invalid.".to_string());
        }
        let reference_workspace = resolve_workspace_root_path(&reference.workspace_root)?;
        if reference_workspace != workspace_path {
            return Err(
                "Media Studio attachment workspace does not match the active Chat workspace."
                    .to_string(),
            );
        }
        if !seen_asset_ids.insert(asset_id.to_string()) {
            continue;
        }
        let asset_path = crate::media::resolve_published_image_asset_path(app_handle, asset_id)?;
        paths.push(asset_path.to_string_lossy().to_string());
    }
    Ok(paths)
}

fn stop_shared_cli_after_wait_error(
    error: io::Error,
    child: &mut SupervisedChild,
    input_worker: JoinHandle<Result<(), String>>,
    stdout_worker: JoinHandle<Result<String, String>>,
    stderr_worker: JoinHandle<Result<Vec<String>, String>>,
    conversation_context_path: Option<&PathBuf>,
) -> String {
    let _ = child.terminate_and_reap();

    let cleanup_result = join_cli_io_and_cleanup(
        input_worker,
        stdout_worker,
        stderr_worker,
        conversation_context_path,
    );
    let message = format!("Failed to wait for the shared CLI to finish: {error}");

    match cleanup_result {
        Ok(_) => message,
        Err(cleanup_error) => {
            format!("{message}. Additionally failed to collect shared CLI output during cleanup: {cleanup_error}")
        }
    }
}

struct JoinedCliIo {
    stdout: String,
    stderr: String,
    input_error: Option<String>,
}

fn join_cli_io_and_cleanup(
    input_worker: JoinHandle<Result<(), String>>,
    stdout_worker: JoinHandle<Result<String, String>>,
    stderr_worker: JoinHandle<Result<Vec<String>, String>>,
    conversation_context_path: Option<&PathBuf>,
) -> Result<JoinedCliIo, String> {
    let input_error = input_worker
        .join()
        .map_err(|_| "The shared CLI input worker stopped unexpectedly.".to_string())
        .and_then(|result| result)
        .err();
    let (stdout, stderr) =
        join_cli_output_and_cleanup(stdout_worker, stderr_worker, conversation_context_path)?;
    Ok(JoinedCliIo {
        stdout,
        stderr,
        input_error,
    })
}

fn write_cli_task(mut destination: impl io::Write, task: &[u8]) -> Result<(), String> {
    destination
        .write_all(task)
        .and_then(|()| destination.flush())
        .map_err(|error| format!("Failed to write the task to shared CLI stdin: {error}"))
}

const MAX_STDIN_TASK_BYTES: usize = 64 * 1024 * 1024;

fn normalize_desktop_task_input(task: &str, max_bytes: usize) -> Result<&str, String> {
    if task.len() > max_bytes {
        return Err(format!(
            "Task input exceeds the {max_bytes}-byte desktop limit."
        ));
    }
    let normalized = task.trim();
    if normalized.is_empty() {
        return Err("Expected a non-empty task before running the desktop executor.".to_string());
    }
    Ok(normalized)
}

pub(super) fn execute_desktop_task(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: DesktopTaskRunRequest,
    cancel_flag: Arc<AtomicBool>,
    termination_state: Arc<AtomicU8>,
) -> Result<DesktopTaskRunResponse, String> {
    let DesktopTaskRunRequest {
        workspace_root,
        task,
        mode,
        provider,
        model,
        reasoning,
        conversation_context,
        image_paths,
        media_asset_references,
        task_id,
        session_id: _,
        operation_kind: _,
        deterministic_action,
    } = request;
    let file_change_detection_enabled = !workspace_root.trim().is_empty();
    let workspace_path = resolve_workspace_root_path(&workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let mut resolved_image_paths = image_paths.unwrap_or_default();
    resolved_image_paths.extend(resolve_media_asset_reference_paths(
        &app_handle,
        &workspace_path,
        media_asset_references.unwrap_or_default(),
    )?);
    if resolved_image_paths.len() > 20 {
        return Err("A desktop task can attach at most 20 images.".to_string());
    }

    let normalized_task = normalize_desktop_task_input(&task, MAX_STDIN_TASK_BYTES)?;

    let normalized_provider = normalize_optional_string(provider.as_deref());
    let normalized_mode = normalize_optional_string(mode.as_deref());
    let normalized_model = normalize_optional_string(model.as_deref());
    let normalized_reasoning = normalize_optional_string(reasoning.as_deref());
    let conversation_context = enrich_ui_control_conversation_context(conversation_context)?;
    let conversation_context = crate::workspace_run::enrich_conversation_context(
        &app_handle,
        &normalized_workspace_root,
        conversation_context,
    )?;
    let conversation_context_path = conversation_context
        .as_ref()
        .map(write_conversation_context_file)
        .transpose()?;
    let deterministic_action_json = deterministic_action
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("Failed to serialize the deterministic action: {error}"))?;

    let cli_args = build_cli_args(CliCommandOptions {
        workspace_root: &normalized_workspace_root,
        file_change_detection_enabled,
        mode: normalized_mode.as_deref(),
        provider: normalized_provider.as_deref(),
        model: normalized_model.as_deref(),
        reasoning: normalized_reasoning.as_deref(),
        conversation_context_file: conversation_context_path.as_deref(),
        image_paths: &resolved_image_paths,
        deterministic_action_json: deterministic_action_json.as_deref(),
    });
    let mut cli_command =
        crate::shared_cli::create_shared_cli_command(&cli_args).inspect_err(|_error| {
            cleanup_temporary_file(conversation_context_path.as_ref());
        })?;

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
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(credentials) = app_handle
        .state::<crate::workspace_run::WorkspaceRunState>()
        .control_credentials()
    {
        cli_command
            .command
            .env("MACHDOCH_RUN_CONTROL_ADDRESS", credentials.address)
            .env("MACHDOCH_RUN_CONTROL_TOKEN", credentials.token);
    }

    let mut child = SupervisedChild::spawn_with_required_isolation(&mut cli_command.command)
        .map_err(|error| {
            cleanup_temporary_file(conversation_context_path.as_ref());

            match error {
                SupervisedChildSpawnError::Spawn(error) => format!(
                    "Failed to launch the shared CLI. {} {error}",
                    crate::shared_cli::cli_runtime_error_hint()
                ),
                SupervisedChildSpawnError::Isolation(error) => error,
            }
        })?;

    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.terminate_and_reap();
            cleanup_temporary_file(conversation_context_path.as_ref());
            return Err(
                "The shared CLI did not expose a stdin stream for the desktop bridge.".to_string(),
            );
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.terminate_and_reap();
            cleanup_temporary_file(conversation_context_path.as_ref());
            return Err(
                "The shared CLI did not expose a stdout stream for the desktop bridge.".to_string(),
            );
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.terminate_and_reap();
            cleanup_temporary_file(conversation_context_path.as_ref());
            return Err(
                "The shared CLI did not expose a stderr stream for the desktop bridge.".to_string(),
            );
        }
    };
    let progress_app_handle = app_handle.clone();
    let storage_app_handle = app_handle.clone();
    let progress_window_label = window_label.clone();
    let progress_task_id = task_id.clone();
    let storage_task_id = task_id.clone();

    let activity = create_desktop_task_activity();
    let stderr_activity = activity.clone();
    let task_input = normalized_task.as_bytes().to_vec();
    let input_worker = thread::spawn(move || write_cli_task(stdin, &task_input));
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
                    input_worker,
                    stdout_worker,
                    stderr_worker,
                    conversation_context_path.as_ref(),
                ));
            }
            Ok(None) => {
                if cancel_flag.load(Ordering::SeqCst) {
                    termination_state.store(DESKTOP_TASK_TERMINATION_CANCELLED, Ordering::SeqCst);
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

                    let _ = child.terminate_and_reap();

                    let io = join_cli_io_and_cleanup(
                        input_worker,
                        stdout_worker,
                        stderr_worker,
                        conversation_context_path.as_ref(),
                    )?;

                    let failure_tail = format_command_failure(&io.stderr, &io.stdout);
                    return Err(format!("The task was cancelled. {}", failure_tail));
                }

                if desktop_task_activity_elapsed(&activity)
                    >= Duration::from_millis(DESKTOP_TASK_IDLE_TIMEOUT_MS)
                {
                    termination_state
                        .store(DESKTOP_TASK_TERMINATION_IDLE_TIMEOUT, Ordering::SeqCst);
                    emit_progress_event(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        create_bridge_progress(
                            normalized_task,
                            normalized_mode.as_deref(),
                            "cancelled",
                            "Execution produced no structured progress before the desktop inactivity timeout; stopping the task.",
                            false,
                        ),
                    );

                    let _ = child.terminate_and_reap();

                    let io = join_cli_io_and_cleanup(
                        input_worker,
                        stdout_worker,
                        stderr_worker,
                        conversation_context_path.as_ref(),
                    )?;

                    let failure_tail = format_command_failure(&io.stderr, &io.stdout);
                    return Err(format!(
                        "The shared CLI produced no structured progress for {} and was stopped. {}",
                        format_timeout_duration(DESKTOP_TASK_IDLE_TIMEOUT_MS),
                        failure_tail
                    ));
                }

                thread::sleep(Duration::from_millis(DESKTOP_TASK_WAIT_POLL_MS));
            }
        }
    };
    let io = join_cli_io_and_cleanup(
        input_worker,
        stdout_worker,
        stderr_worker,
        conversation_context_path.as_ref(),
    )?;
    if let Some(input_error) = io.input_error {
        return Err(format!(
            "{input_error} {}",
            format_command_failure(&io.stderr, &io.stdout)
        ));
    }
    let stdout_text = io.stdout;
    let stderr_text = io.stderr;

    let parsed_response = if stdout_text.trim().is_empty() {
        None
    } else {
        parse_desktop_task_response(&stdout_text).ok()
    };

    if !status.success() {
        if let Some(mut response) = parsed_response {
            if !is_expected_cancelled_desktop_task_response(status.code(), &response) {
                return Err(format!(
                    "The shared CLI could not complete the task. {}",
                    format_command_failure(&stderr_text, &stdout_text)
                ));
            }
            if let Err(error) = super::file_changes::persist_response(
                &storage_app_handle,
                storage_task_id.as_deref(),
                &mut response,
            ) {
                super::file_changes::annotate_persistence_failure(&mut response, &error);
            }
            return Ok(response);
        }
        return Err(format!(
            "The shared CLI could not complete the task. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    let mut response = match parsed_response {
        Some(response) => response,
        None => parse_desktop_task_response(&stdout_text)?,
    };
    if let Err(error) = super::file_changes::persist_response(
        &storage_app_handle,
        storage_task_id.as_deref(),
        &mut response,
    ) {
        super::file_changes::annotate_persistence_failure(&mut response, &error);
    }
    Ok(response)
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

    use super::{
        is_expected_cancelled_desktop_task_response, normalize_desktop_task_input,
        parse_desktop_task_response, stop_shared_cli_after_wait_error, write_cli_task,
    };
    use crate::child_process::SupervisedChild;
    use crate::desktop_task::diagnostics::COMMAND_DIAGNOSTIC_TRUNCATED_MARKER;
    use crate::desktop_task::payload::write_conversation_context_file;

    const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_DESKTOP_TASK_WAIT_ERROR_TEST_CHILD_MODE";

    #[test]
    fn desktop_task_stdin_preserves_large_multiline_utf8_content() {
        let task = format!("{}final ünicode line", "first line\n".repeat(40_000));
        let mut output = Vec::new();

        write_cli_task(&mut output, task.as_bytes()).expect("task write should succeed");

        assert_eq!(output, task.as_bytes());
    }

    #[test]
    fn desktop_task_input_limit_counts_discarded_whitespace() {
        assert_eq!(
            normalize_desktop_task_input("  task  ", 8).expect("bounded task should normalize"),
            "task"
        );
        assert!(normalize_desktop_task_input("     task", 8)
            .expect_err("raw oversized padding must be rejected")
            .contains("8-byte"));
        assert!(normalize_desktop_task_input(" \r\n ", 8)
            .expect_err("blank task must be rejected")
            .contains("non-empty"));
    }

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

        let mut child = SupervisedChild::spawn(&mut command).expect("test child should start");
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
            io::Error::other("simulated wait failure"),
            &mut child,
            thread::spawn(|| Ok(())),
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

    #[test]
    fn only_cancelled_responses_may_survive_a_nonzero_cli_exit() {
        let cancelled = parse_desktop_task_response(r#"{"execution":{"status":"cancelled"}}"#)
            .expect("cancelled fixture should parse");
        let executed = parse_desktop_task_response(r#"{"execution":{"status":"executed"}}"#)
            .expect("executed fixture should parse");

        assert!(is_expected_cancelled_desktop_task_response(
            Some(130),
            &cancelled
        ));
        assert!(!is_expected_cancelled_desktop_task_response(
            Some(1),
            &cancelled
        ));
        assert!(!is_expected_cancelled_desktop_task_response(
            Some(130),
            &executed
        ));
    }
}
