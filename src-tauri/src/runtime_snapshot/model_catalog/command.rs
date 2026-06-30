use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(super) struct AgentCliCommandOutput {
    pub(super) exit_code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

fn read_agent_cli_stream(mut stream: impl Read, description: &str) -> Result<String, String> {
    let mut output = String::new();
    stream
        .read_to_string(&mut output)
        .map_err(|error| format!("Failed to read agent CLI {description}: {error}"))?;

    Ok(output)
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
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {}: {error}", executable.display()))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
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
            let _ = child.kill();
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
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} timed out while discovering agent CLI models.",
                    executable.display()
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                return Err(format!(
                    "Failed while waiting for {}: {error}",
                    executable.display()
                ));
            }
        }
    };
    let stdout = join_agent_cli_stream_worker(stdout_worker, "stdout")?;
    let stderr = join_agent_cli_stream_worker(stderr_worker, "stderr")?;

    Ok(AgentCliCommandOutput {
        exit_code: status.code(),
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, path::PathBuf, time::Duration};

    use super::run_agent_cli_command;

    #[cfg(target_os = "windows")]
    fn large_output_command() -> (PathBuf, Vec<&'static str>) {
        (
            PathBuf::from("powershell.exe"),
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$chunk = 'x' * 8192; 1..128 | ForEach-Object { [Console]::Out.Write($chunk); [Console]::Error.Write($chunk) }",
            ],
        )
    }

    #[cfg(target_os = "windows")]
    fn nonzero_output_command() -> (PathBuf, Vec<&'static str>) {
        (
            PathBuf::from("powershell.exe"),
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('stdout-value'); [Console]::Error.Write('stderr-value'); exit 7",
            ],
        )
    }

    #[cfg(not(target_os = "windows"))]
    fn large_output_command() -> (PathBuf, Vec<&'static str>) {
        (
            PathBuf::from("/bin/sh"),
            vec![
                "-c",
                "i=0; while [ \"$i\" -lt 128 ]; do head -c 8192 /dev/zero | tr '\\0' x; head -c 8192 /dev/zero | tr '\\0' x >&2; i=$((i + 1)); done",
            ],
        )
    }

    #[cfg(not(target_os = "windows"))]
    fn nonzero_output_command() -> (PathBuf, Vec<&'static str>) {
        (
            PathBuf::from("/bin/sh"),
            vec!["-c", "printf stdout-value; printf stderr-value >&2; exit 7"],
        )
    }

    #[test]
    fn agent_cli_command_drains_large_stdout_and_stderr_while_running() {
        let (executable, args) = large_output_command();
        let output = run_agent_cli_command(
            &executable,
            args.as_slice(),
            &HashMap::new(),
            Duration::from_secs(10),
        )
        .expect("large stdout and stderr should not block child process exit");

        assert_eq!(output.exit_code, Some(0));
        assert_eq!(output.stdout.len(), 8192 * 128);
        assert_eq!(output.stderr.len(), 8192 * 128);
    }

    #[test]
    fn agent_cli_command_preserves_nonzero_status_stdout_and_stderr() {
        let (executable, args) = nonzero_output_command();
        let output = run_agent_cli_command(
            &executable,
            args.as_slice(),
            &HashMap::new(),
            Duration::from_secs(10),
        )
        .expect("nonzero command output should still be returned");

        assert_eq!(output.exit_code, Some(7));
        assert_eq!(output.stdout, "stdout-value");
        assert_eq!(output.stderr, "stderr-value");
    }
}
