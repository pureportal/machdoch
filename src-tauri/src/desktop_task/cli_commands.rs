use std::{
    io,
    io::Read,
    process::{Child, Command, ExitStatus, Stdio},
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
    payload::cleanup_temporary_files,
    payload_files::rewrite_task_interview_payload_arguments,
    process::{hide_child_process_window, terminate_child_process_tree},
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

fn read_cli_stream_text(mut stream: impl Read, stream_name: &str) -> Result<String, String> {
    let mut output = Vec::new();

    stream
        .read_to_end(&mut output)
        .map_err(|error| format!("Failed to read the shared CLI {stream_name} stream: {error}"))?;

    Ok(String::from_utf8_lossy(&output).to_string())
}

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
    timeout_ms: u64,
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

    let stdout_worker = thread::spawn(move || read_cli_stream_text(stdout, "stdout"));
    let stderr_worker = thread::spawn(move || read_cli_stream_text(stderr, "stderr"));
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
                if started_at.elapsed() >= Duration::from_millis(timeout_ms) {
                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

                    let (stdout_text, stderr_text) =
                        join_auxiliary_cli_output(stdout_worker, stderr_worker)?;
                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);

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

fn parse_scheduler_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the scheduler CLI JSON response: {error}. Output: {trimmed_stdout}"
        )
    })
}

fn parse_mcp_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!("Failed to parse the MCP CLI JSON response: {error}. Output: {trimmed_stdout}")
    })
}

fn parse_instruction_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the instruction CLI JSON response: {error}. Output: {trimmed_stdout}"
        )
    })
}

fn parse_task_interview_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the task interview CLI JSON response: {error}. Output: {trimmed_stdout}"
        )
    })
}

pub(super) fn execute_scheduler_command(request: SchedulerCommandRequest) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "scheduler".to_string(),
    ];

    for argument in request.arguments {
        let normalized = argument.trim();

        if !normalized.is_empty() {
            cli_args.push(normalized.to_string());
        }
    }

    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;

    let output = run_bounded_auxiliary_cli_command(
        &mut cli_command.command,
        "scheduler",
        DESKTOP_TASK_TIMEOUT_MS,
    )?;
    let stdout_text = output.stdout;
    let stderr_text = output.stderr;

    if !output.status.success() {
        return Err(format!(
            "The scheduler CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_scheduler_command_response(&stdout_text)
}

pub(super) fn execute_mcp_command(request: McpCommandRequest) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "mcp".to_string(),
    ];

    for argument in request.arguments {
        let normalized = argument.trim();

        if !normalized.is_empty() {
            cli_args.push(normalized.to_string());
        }
    }

    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;

    let output = run_bounded_auxiliary_cli_command(
        &mut cli_command.command,
        "MCP",
        DESKTOP_TASK_TIMEOUT_MS,
    )?;
    let stdout_text = output.stdout;
    let stderr_text = output.stderr;

    if !output.status.success() {
        return Err(format!(
            "The MCP CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_mcp_command_response(&stdout_text)
}

pub(super) fn execute_instruction_command(
    request: InstructionCommandRequest,
) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "instructions".to_string(),
    ];

    for argument in request.arguments {
        let normalized = argument.trim();

        if !normalized.is_empty() {
            cli_args.push(normalized.to_string());
        }
    }

    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;

    let output = run_bounded_auxiliary_cli_command(
        &mut cli_command.command,
        "instruction",
        DESKTOP_TASK_TIMEOUT_MS,
    )?;
    let stdout_text = output.stdout;
    let stderr_text = output.stderr;

    if !output.status.success() {
        return Err(format!(
            "The instruction CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_instruction_command_response(&stdout_text)
}

pub(super) fn execute_task_interview_command(
    request: TaskInterviewCommandRequest,
) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let (arguments, payload_paths) =
        rewrite_task_interview_payload_arguments(&normalized_workspace_root, request.arguments)?;
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "interview".to_string(),
    ];

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

    let output = match run_bounded_auxiliary_cli_command(
        &mut cli_command.command,
        "task interview",
        DESKTOP_TASK_TIMEOUT_MS,
    ) {
        Ok(output) => output,
        Err(error) => {
            cleanup_temporary_files(&payload_paths);
            return Err(error);
        }
    };
    cleanup_temporary_files(&payload_paths);
    let stdout_text = output.stdout;
    let stderr_text = output.stderr;

    if !output.status.success() {
        return Err(format!(
            "The task interview CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_task_interview_command_response(&stdout_text)
}

#[cfg(test)]
mod tests {
    use std::{env, process::Command, thread, time::Duration};

    use super::run_bounded_auxiliary_cli_command;

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
            _ => {}
        }
    }

    #[test]
    fn bounded_auxiliary_cli_command_captures_success_output() {
        let mut command = test_child_command("json");
        let output = run_bounded_auxiliary_cli_command(&mut command, "scheduler", 5_000)
            .expect("bounded command should finish");

        assert!(output.status.success());
        assert!(output.stdout.contains(r#"{"ok":true}"#));
        assert!(output.stderr.contains("child stderr"));
    }

    #[test]
    fn bounded_auxiliary_cli_command_times_out_and_stops_child() {
        let mut command = test_child_command("hang");
        let error = run_bounded_auxiliary_cli_command(&mut command, "scheduler", 1_000)
            .expect_err("hanging command should time out");

        assert!(error.contains("The scheduler CLI exceeded the desktop safety timeout"));
        assert!(error.contains("was stopped"));
    }
}
