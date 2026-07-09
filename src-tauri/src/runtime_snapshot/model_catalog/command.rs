use std::{
    collections::HashMap,
    io::{self, Read},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(super) const AGENT_CLI_OUTPUT_CAPTURE_LIMIT_BYTES: usize = 1024 * 1024;
pub(super) const AGENT_CLI_OUTPUT_TRUNCATED_MARKER: &str = "[output truncated after capture limit]";

pub(super) struct AgentCliCommandOutput {
    pub(super) exit_code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

fn read_agent_cli_stream(mut stream: impl Read, description: &str) -> Result<String, String> {
    let mut captured = Vec::with_capacity(AGENT_CLI_OUTPUT_CAPTURE_LIMIT_BYTES.min(8192));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];

    loop {
        let bytes_read = stream
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read agent CLI {description}: {error}"))?;

        if bytes_read == 0 {
            break;
        }

        if truncated {
            continue;
        }

        let remaining = AGENT_CLI_OUTPUT_CAPTURE_LIMIT_BYTES.saturating_sub(captured.len());

        if bytes_read <= remaining {
            captured.extend_from_slice(&buffer[..bytes_read]);
        } else {
            captured.extend_from_slice(&buffer[..remaining]);
            truncated = true;
        }
    }

    Ok(decode_agent_cli_output(captured, truncated))
}

fn decode_agent_cli_output(captured: Vec<u8>, truncated: bool) -> String {
    let mut output = String::from_utf8_lossy(&captured).to_string();

    if truncated {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }

        output.push_str(AGENT_CLI_OUTPUT_TRUNCATED_MARKER);
    }

    output
}

fn join_agent_cli_stream_worker(
    handle: thread::JoinHandle<Result<String, String>>,
    description: &str,
) -> Result<String, String> {
    match handle.join() {
        Ok(result) => result,
        Err(_) => Err(format!(
            "The agent CLI {description} reader terminated unexpectedly."
        )),
    }
}

fn join_agent_cli_output(
    stdout_worker: thread::JoinHandle<Result<String, String>>,
    stderr_worker: thread::JoinHandle<Result<String, String>>,
) -> Result<(String, String), String> {
    let stdout = join_agent_cli_stream_worker(stdout_worker, "stdout")?;
    let stderr = join_agent_cli_stream_worker(stderr_worker, "stderr")?;

    Ok((stdout, stderr))
}

fn terminate_agent_cli_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let taskkill_result = Command::new("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();

        if taskkill_result
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return;
        }
    }

    #[cfg(unix)]
    {
        let process_group_id = format!("-{}", child.id());
        let kill_result = Command::new("kill")
            .args(["-TERM", process_group_id.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        if kill_result.map(|status| status.success()).unwrap_or(false) {
            return;
        }
    }

    let _ = child.kill();
}

fn stop_agent_cli_after_wait_error(
    error: io::Error,
    executable: &Path,
    child: &mut Child,
    stdout_worker: thread::JoinHandle<Result<String, String>>,
    stderr_worker: thread::JoinHandle<Result<String, String>>,
) -> String {
    terminate_agent_cli_process_tree(child);
    let _ = child.wait();

    let cleanup_result = join_agent_cli_output(stdout_worker, stderr_worker);
    let message = format!("Failed while waiting for {}: {error}", executable.display());

    match cleanup_result {
        Ok(_) => message,
        Err(cleanup_error) => {
            format!("{message}. Additionally failed to collect agent CLI output during cleanup: {cleanup_error}")
        }
    }
}

pub(super) fn run_agent_cli_command(
    executable: &Path,
    args: &[&str],
    env_values: &HashMap<String, String>,
    timeout: Duration,
) -> Result<AgentCliCommandOutput, String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .envs(env_values)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {}: {error}", executable.display()))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_agent_cli_process_tree(&mut child);
            let _ = child.wait();
            return Err(format!(
                "{} did not expose a stdout stream for agent CLI model discovery.",
                executable.display()
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_agent_cli_process_tree(&mut child);
            let _ = child.wait();
            return Err(format!(
                "{} did not expose a stderr stream for agent CLI model discovery.",
                executable.display()
            ));
        }
    };
    let stdout_worker = thread::spawn(move || read_agent_cli_stream(stdout, "stdout"));
    let stderr_worker = thread::spawn(move || read_agent_cli_stream(stderr, "stderr"));
    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started_at.elapsed() >= timeout => {
                terminate_agent_cli_process_tree(&mut child);
                let _ = child.wait();
                let _ = join_agent_cli_output(stdout_worker, stderr_worker);
                return Err(format!(
                    "{} timed out while discovering agent CLI models.",
                    executable.display()
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                return Err(stop_agent_cli_after_wait_error(
                    error,
                    executable,
                    &mut child,
                    stdout_worker,
                    stderr_worker,
                ));
            }
        }
    };
    let (stdout, stderr) = join_agent_cli_output(stdout_worker, stderr_worker)?;

    Ok(AgentCliCommandOutput {
        exit_code: status.code(),
        stdout,
        stderr,
    })
}
