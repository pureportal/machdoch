use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use crate::child_process::SupervisedChild;

use super::super::MediaResult;

const MAX_OUTPUT_BYTES: usize = 64 * 1024;

fn drain(mut stream: impl Read) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Ok(output);
        }
        output.extend_from_slice(&buffer[..count]);
        if output.len() > MAX_OUTPUT_BYTES {
            output.drain(..output.len() - MAX_OUTPUT_BYTES);
        }
    }
}

pub(super) fn run(command: &mut Command, timeout: Duration) -> MediaResult<String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = SupervisedChild::spawn_with_required_isolation(command)
        .map_err(|error| format!("Could not start setup process: {error}"))?;
    let stdout = child.stdout.take().ok_or("Setup stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("Setup stderr is unavailable")?;
    let stdout_reader = thread::spawn(move || drain(stdout));
    let stderr_reader = thread::spawn(move || drain(stderr));
    let started = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(100)),
            Ok(None) => break Err("Setup process timed out".to_string()),
            Err(error) => break Err(format!("Could not monitor setup process: {error}")),
        }
    };
    if result.is_err() {
        child
            .terminate_and_reap()
            .map_err(|error| format!("Could not stop setup process: {error}"))?;
    }
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Setup output reader failed")?
        .map_err(|error| error.to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Setup diagnostic reader failed")?
        .map_err(|error| error.to_string())?;
    let status = result?;
    if !status.success() {
        return Err(format!(
            "Setup process exited with {status}: {}\n{}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}
