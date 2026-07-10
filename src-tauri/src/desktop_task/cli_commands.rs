use std::{
    fs::{self, OpenOptions},
    io,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::Value;

use crate::runtime_snapshot::{get_user_config_directory, resolve_workspace_root_path};

use super::{
    diagnostics::{format_command_failure, format_diagnostic_snippet, format_timeout_duration},
    payload::cleanup_temporary_files,
    payload_files::rewrite_task_interview_payload_arguments,
    process::{
        create_desktop_task_activity, hide_child_process_window, read_bounded_stream_text,
        read_stderr, terminate_child_process_tree,
    },
    registry::normalize_task_id,
    InstructionCommandRequest, McpCommandRequest, SchedulerCommandRequest,
    TaskInterviewCommandRequest, DESKTOP_TASK_TIMEOUT_MS, DESKTOP_TASK_WAIT_POLL_MS,
};

#[cfg(target_os = "windows")]
use super::process::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

#[derive(Debug)]
struct AuxiliaryCliOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

struct AuxiliaryCliSpec {
    subcommand: &'static str,
    command_name: &'static str,
    parse_name: &'static str,
    failure_name: &'static str,
}

struct AuxiliaryCliProgressContext {
    app_handle: tauri::AppHandle,
    window_label: String,
    task_id: Option<String>,
}

const SCHEDULER_CLI_SPEC: AuxiliaryCliSpec = AuxiliaryCliSpec {
    subcommand: "scheduler",
    command_name: "scheduler",
    parse_name: "scheduler",
    failure_name: "scheduler",
};

const MCP_CLI_SPEC: AuxiliaryCliSpec = AuxiliaryCliSpec {
    subcommand: "mcp",
    command_name: "MCP",
    parse_name: "MCP",
    failure_name: "MCP",
};

const INSTRUCTION_CLI_SPEC: AuxiliaryCliSpec = AuxiliaryCliSpec {
    subcommand: "instructions",
    command_name: "instruction",
    parse_name: "instruction",
    failure_name: "instruction",
};

const TASK_INTERVIEW_CLI_SPEC: AuxiliaryCliSpec = AuxiliaryCliSpec {
    subcommand: "interview",
    command_name: "task interview",
    parse_name: "task interview",
    failure_name: "task interview",
};

fn join_auxiliary_cli_output(
    stdout_worker: thread::JoinHandle<Result<String, String>>,
    stderr_worker: thread::JoinHandle<Result<String, String>>,
) -> Result<(String, String), String> {
    let stdout_text = stdout_worker
        .join()
        .map_err(|_| "The shared CLI stdout worker terminated unexpectedly.".to_string())??;
    let stderr_text = stderr_worker
        .join()
        .map_err(|_| "The shared CLI stderr worker terminated unexpectedly.".to_string())??;

    Ok((stdout_text, stderr_text))
}

fn stop_auxiliary_cli_after_wait_error(
    error: io::Error,
    child: &mut Child,
    stdout_worker: thread::JoinHandle<Result<String, String>>,
    stderr_worker: thread::JoinHandle<Result<String, String>>,
    command_name: &str,
) -> String {
    terminate_child_process_tree(child);
    let _ = child.wait();

    let cleanup_result = join_auxiliary_cli_output(stdout_worker, stderr_worker);
    let message = format!("Failed to wait for the {command_name} CLI to finish: {error}");

    match cleanup_result {
        Ok(_) => message,
        Err(cleanup_error) => {
            format!("{message}. Additionally failed to collect {command_name} CLI output during cleanup: {cleanup_error}")
        }
    }
}

fn run_bounded_auxiliary_cli_command(
    command: &mut Command,
    command_name: &str,
    timeout_ms: Option<u64>,
    progress_context: Option<AuxiliaryCliProgressContext>,
) -> Result<AuxiliaryCliOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_child_process_window(command);

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to launch the {command_name} CLI. {} {error}",
            crate::shared_cli::cli_runtime_error_hint()
        )
    })?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            return Err(format!(
                "The {command_name} CLI did not expose a stdout stream."
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            return Err(format!(
                "The {command_name} CLI did not expose a stderr stream."
            ));
        }
    };

    let stdout_worker = thread::spawn(move || read_bounded_stream_text(stdout, "stdout"));
    let stderr_worker = match progress_context {
        Some(context) => {
            let activity = create_desktop_task_activity();

            thread::spawn(move || {
                read_stderr(
                    stderr,
                    context.app_handle,
                    context.window_label,
                    context.task_id,
                    activity,
                )
                .map(|lines| lines.join("\n"))
            })
        }
        None => thread::spawn(move || read_bounded_stream_text(stderr, "stderr")),
    };
    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Err(error) => {
                return Err(stop_auxiliary_cli_after_wait_error(
                    error,
                    &mut child,
                    stdout_worker,
                    stderr_worker,
                    command_name,
                ));
            }
            Ok(None) => {
                if timeout_ms
                    .map(|timeout_ms| started_at.elapsed() >= Duration::from_millis(timeout_ms))
                    .unwrap_or(false)
                {
                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

                    let (stdout_text, stderr_text) =
                        join_auxiliary_cli_output(stdout_worker, stderr_worker)?;
                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);
                    let timeout_ms = timeout_ms.unwrap_or_default();

                    return Err(format!(
                        "The {command_name} CLI exceeded the desktop safety timeout of {} and was stopped. {}",
                        format_timeout_duration(timeout_ms),
                        failure_tail
                    ));
                }

                thread::sleep(Duration::from_millis(DESKTOP_TASK_WAIT_POLL_MS));
            }
        }
    };
    let (stdout, stderr) = join_auxiliary_cli_output(stdout_worker, stderr_worker)?;

    Ok(AuxiliaryCliOutput {
        status,
        stdout,
        stderr,
    })
}

fn build_auxiliary_cli_args(
    workspace_root: &str,
    subcommand: &str,
    arguments: impl IntoIterator<Item = String>,
) -> Result<Vec<String>, String> {
    let workspace_path = resolve_workspace_root_path(workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        subcommand.to_string(),
    ];

    append_normalized_arguments(&mut cli_args, arguments);

    Ok(cli_args)
}

fn append_normalized_arguments(
    cli_args: &mut Vec<String>,
    arguments: impl IntoIterator<Item = String>,
) {
    for argument in arguments {
        let normalized = argument.trim();

        if !normalized.is_empty() {
            cli_args.push(normalized.to_string());
        }
    }
}

fn parse_auxiliary_command_response(stdout: &str, parse_name: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the {parse_name} CLI JSON response: {error}. Output: {}",
            format_diagnostic_snippet(trimmed_stdout)
        )
    })
}

fn finish_auxiliary_command_response(
    output: AuxiliaryCliOutput,
    spec: &AuxiliaryCliSpec,
) -> Result<Value, String> {
    let stdout_text = output.stdout;
    let stderr_text = output.stderr;

    if !output.status.success() {
        return Err(format!(
            "The {} CLI command failed. {}",
            spec.failure_name,
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_auxiliary_command_response(&stdout_text, spec.parse_name)
}

fn run_auxiliary_json_command(
    workspace_root: &str,
    arguments: impl IntoIterator<Item = String>,
    spec: &AuxiliaryCliSpec,
) -> Result<Value, String> {
    let cli_args = build_auxiliary_cli_args(workspace_root, spec.subcommand, arguments)?;
    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;
    let output = run_bounded_auxiliary_cli_command(
        &mut cli_command.command,
        spec.command_name,
        Some(DESKTOP_TASK_TIMEOUT_MS),
        None,
    )?;

    finish_auxiliary_command_response(output, spec)
}

pub(super) fn execute_scheduler_command(request: SchedulerCommandRequest) -> Result<Value, String> {
    run_auxiliary_json_command(
        &request.workspace_root,
        request.arguments,
        &SCHEDULER_CLI_SPEC,
    )
}

pub(super) fn start_scheduler_service(request: SchedulerCommandRequest) -> Result<u32, String> {
    let user_config_directory = get_user_config_directory()?;
    fs::create_dir_all(&user_config_directory)
        .map_err(|error| format!("Failed to create the scheduler service directory: {error}"))?;
    let service_owner_path = user_config_directory
        .join("scheduler-workspaces.json.service-lock")
        .join("owner");
    if let Ok(metadata) = fs::metadata(&service_owner_path) {
        if metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .map(|age| age <= Duration::from_secs(120))
            .unwrap_or(false)
        {
            if let Ok(owner) = fs::read_to_string(&service_owner_path) {
                if let Some(pid) = owner
                    .split(':')
                    .next()
                    .and_then(|value| value.parse::<u32>().ok())
                {
                    return Ok(pid);
                }
            }
        }
    }
    let workspace_path = if request.workspace_root.trim().is_empty() {
        user_config_directory.clone()
    } else {
        resolve_workspace_root_path(&request.workspace_root)?
    };
    let log_path = user_config_directory.join("scheduler-service.log");
    if fs::metadata(&log_path)
        .map(|metadata| metadata.len() > 10 * 1024 * 1024)
        .unwrap_or(false)
    {
        let rotated_log_path = user_config_directory.join("scheduler-service.log.1");
        let _ = fs::remove_file(&rotated_log_path);
        fs::rename(&log_path, &rotated_log_path)
            .map_err(|error| format!("Failed to rotate scheduler service log: {error}"))?;
    }
    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Failed to open scheduler service log: {error}"))?;
    let stderr_log = stdout_log
        .try_clone()
        .map_err(|error| format!("Failed to clone scheduler service log handle: {error}"))?;
    let cli_args = build_auxiliary_cli_args(
        &workspace_path.display().to_string(),
        SCHEDULER_CLI_SPEC.subcommand,
        request.arguments,
    )?;
    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;
    cli_command
        .command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));
    hide_child_process_window(&mut cli_command.command);

    #[cfg(target_os = "windows")]
    {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cli_command
            .command
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }

    #[cfg(unix)]
    {
        cli_command.command.process_group(0);
    }

    cli_command
        .command
        .spawn()
        .map(|child| child.id())
        .map_err(|error| {
            format!(
                "Failed to launch the persistent scheduler service. {} {error}",
                crate::shared_cli::cli_runtime_error_hint()
            )
        })
}

pub(super) fn execute_mcp_command(request: McpCommandRequest) -> Result<Value, String> {
    run_auxiliary_json_command(&request.workspace_root, request.arguments, &MCP_CLI_SPEC)
}

pub(super) fn execute_instruction_command(
    request: InstructionCommandRequest,
) -> Result<Value, String> {
    run_auxiliary_json_command(
        &request.workspace_root,
        request.arguments,
        &INSTRUCTION_CLI_SPEC,
    )
}

pub(super) fn execute_task_interview_command(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: TaskInterviewCommandRequest,
) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let task_id = normalize_task_id(request.task_id.as_deref());
    let (arguments, payload_paths) =
        rewrite_task_interview_payload_arguments(&normalized_workspace_root, request.arguments)?;
    let mut cli_args = vec![
        "--json".to_string(),
        "--verbose".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        TASK_INTERVIEW_CLI_SPEC.subcommand.to_string(),
    ];
    append_normalized_arguments(&mut cli_args, arguments);

    let mut cli_command = match crate::shared_cli::create_shared_cli_command(&cli_args) {
        Ok(command) => command,
        Err(error) => {
            cleanup_temporary_files(&payload_paths);
            return Err(error);
        }
    };

    let output = match run_bounded_auxiliary_cli_command(
        &mut cli_command.command,
        TASK_INTERVIEW_CLI_SPEC.command_name,
        None,
        Some(AuxiliaryCliProgressContext {
            app_handle,
            window_label,
            task_id,
        }),
    ) {
        Ok(output) => output,
        Err(error) => {
            cleanup_temporary_files(&payload_paths);
            return Err(error);
        }
    };
    cleanup_temporary_files(&payload_paths);

    finish_auxiliary_command_response(output, &TASK_INTERVIEW_CLI_SPEC)
}

#[cfg(test)]
mod tests {
    use std::{env, process::Command, thread, time::Duration};

    use super::{parse_auxiliary_command_response, run_bounded_auxiliary_cli_command};
    use crate::desktop_task::diagnostics::COMMAND_DIAGNOSTIC_TRUNCATED_MARKER;
    use crate::desktop_task::process::{
        SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES, SUBPROCESS_OUTPUT_TRUNCATED_MARKER,
    };

    const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_AUXILIARY_CLI_TEST_CHILD_MODE";

    fn test_child_command(mode: &str) -> Command {
        let mut command = Command::new(env::current_exe().expect("test executable should resolve"));

        command
            .arg("--exact")
            .arg("desktop_task::cli_commands::tests::auxiliary_cli_test_child_entrypoint")
            .arg("--nocapture")
            .env(TEST_CHILD_MODE_ENV, mode);

        command
    }

    #[test]
    fn auxiliary_cli_test_child_entrypoint() {
        match env::var(TEST_CHILD_MODE_ENV).as_deref() {
            Ok("json") => {
                println!("{}", r#"{"ok":true}"#);
                eprintln!("child stderr");
            }
            Ok("hang") => thread::sleep(Duration::from_secs(60)),
            Ok("large-output") => {
                let chunk = "x".repeat(8192);

                for _ in 0..256 {
                    print!("{chunk}");
                    eprint!("{chunk}");
                }
            }
            _ => {}
        }
    }

    #[test]
    fn bounded_auxiliary_cli_command_captures_success_output() {
        let mut command = test_child_command("json");
        let output =
            run_bounded_auxiliary_cli_command(&mut command, "scheduler", Some(5_000), None)
                .expect("bounded command should finish");

        assert!(output.status.success());
        assert!(output.stdout.contains(r#"{"ok":true}"#));
        assert!(output.stderr.contains("child stderr"));
    }

    #[test]
    fn bounded_auxiliary_cli_command_times_out_and_stops_child() {
        let mut command = test_child_command("hang");
        let error = run_bounded_auxiliary_cli_command(&mut command, "scheduler", Some(1_000), None)
            .expect_err("hanging command should time out");

        assert!(error.contains("The scheduler CLI exceeded the desktop safety timeout"));
        assert!(error.contains("was stopped"));
    }

    #[test]
    fn bounded_auxiliary_cli_command_caps_stdout_and_stderr() {
        let mut command = test_child_command("large-output");
        let output =
            run_bounded_auxiliary_cli_command(&mut command, "scheduler", Some(10_000), None)
                .expect("large output command should finish");

        assert!(output.status.success());
        assert!(output.stdout.len() < SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES + 256);
        assert!(output.stderr.len() < SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES + 256);
        assert!(output.stdout.contains(SUBPROCESS_OUTPUT_TRUNCATED_MARKER));
        assert!(output.stderr.contains(SUBPROCESS_OUTPUT_TRUNCATED_MARKER));
        assert!(std::str::from_utf8(output.stdout.as_bytes()).is_ok());
        assert!(std::str::from_utf8(output.stderr.as_bytes()).is_ok());
    }

    #[test]
    fn auxiliary_parse_error_uses_bounded_output_snippet() {
        let error = parse_auxiliary_command_response(&"not-json".repeat(20 * 1024), "scheduler")
            .expect_err("invalid JSON should fail");

        assert!(error.contains("Failed to parse the scheduler CLI JSON response"));
        assert!(error.contains(COMMAND_DIAGNOSTIC_TRUNCATED_MARKER));
        assert!(error.len() < 18 * 1024);
    }
}
