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
    let mut stdout = String::new();
    let mut stderr = String::new();

    if let Some(mut stream) = child.stdout.take() {
        stream
            .read_to_string(&mut stdout)
            .map_err(|error| format!("Failed to read agent CLI stdout: {error}"))?;
    }

    if let Some(mut stream) = child.stderr.take() {
        stream
            .read_to_string(&mut stderr)
            .map_err(|error| format!("Failed to read agent CLI stderr: {error}"))?;
    }

    Ok(AgentCliCommandOutput {
        exit_code: status.code(),
        stdout,
        stderr,
    })
}
