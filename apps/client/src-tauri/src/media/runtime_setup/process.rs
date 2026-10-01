use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use crate::child_process::SupervisedChild;

use super::super::MediaResult;
use super::{retain_diagnostic_context, MAX_DIAGNOSTIC_CHARS, OUTPUT_OMITTED};

const MAX_OUTPUT_BYTES: usize = 64 * 1024;

struct CapturedOutput {
    start: Vec<u8>,
    end: Vec<u8>,
    truncated: bool,
}

impl CapturedOutput {
    fn text(&self) -> String {
        if self.truncated {
            let start = String::from_utf8_lossy(&self.start);
            let end = String::from_utf8_lossy(&self.end);
            format!("{start}{OUTPUT_OMITTED}{end}")
        } else {
            let mut bytes = Vec::with_capacity(self.start.len() + self.end.len());
            bytes.extend_from_slice(&self.start);
            bytes.extend_from_slice(&self.end);
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }
}

fn drain(mut stream: impl Read) -> std::io::Result<CapturedOutput> {
    let mut output = CapturedOutput {
        start: Vec::with_capacity(MAX_OUTPUT_BYTES / 2),
        end: Vec::with_capacity(MAX_OUTPUT_BYTES / 2),
        truncated: false,
    };
    let mut buffer = [0; 8192];
    loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Ok(output);
        }
        let start_count = count.min(MAX_OUTPUT_BYTES / 2 - output.start.len());
        output.start.extend_from_slice(&buffer[..start_count]);
        let end = &buffer[start_count..count];
        let overflow = (output.end.len() + end.len()).saturating_sub(MAX_OUTPUT_BYTES / 2);
        if overflow > 0 {
            output.end.drain(..overflow);
            output.truncated = true;
        }
        output.end.extend_from_slice(end);
    }
}

fn failure_diagnostic(reason: &str, stdout: &CapturedOutput, stderr: &CapturedOutput) -> String {
    let heading = format!("{reason}\nstdout:\n");
    let separator = "\nstderr:\n";
    let budget = MAX_DIAGNOSTIC_CHARS - heading.chars().count() - separator.chars().count();
    let stdout = stdout.text();
    let stderr = stderr.text();
    let stdout_count = stdout.chars().count();
    let stderr_count = stderr.chars().count();
    let stdout_budget = budget
        .saturating_sub(stderr_count.min(budget / 2))
        .min(stdout_count);
    let stderr_budget = budget - stdout_budget;
    format!(
        "{heading}{}{separator}{}",
        retain_diagnostic_context(&stdout, stdout_budget),
        retain_diagnostic_context(&stderr, stderr_budget),
    )
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
    let status = result.map_err(|reason| failure_diagnostic(&reason, &stdout, &stderr))?;
    if !status.success() {
        return Err(failure_diagnostic(
            &format!("Setup process exited with {status}"),
            &stdout,
            &stderr,
        ));
    }
    Ok(stdout.text())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_retention_preserves_complete_output_within_limit() {
        for size in [
            0,
            100,
            MAX_OUTPUT_BYTES / 2,
            MAX_OUTPUT_BYTES - 1,
            MAX_OUTPUT_BYTES,
        ] {
            let output = "x".repeat(size);
            let retained = drain(output.as_bytes()).unwrap();
            assert_eq!(retained.text(), output);
            assert!(!retained.truncated);
        }
        let output = format!("{}💥final", "x".repeat(MAX_OUTPUT_BYTES / 2 - 1));
        assert_eq!(drain(output.as_bytes()).unwrap().text(), output);
    }

    #[test]
    fn output_retention_keeps_both_ends_with_bounded_storage() {
        for size in [MAX_OUTPUT_BYTES + 1, MAX_OUTPUT_BYTES * 4] {
            let output = format!("early{}late", "x".repeat(size - 9));
            let retained = drain(output.as_bytes()).unwrap();
            assert_eq!(retained.start, output.as_bytes()[..MAX_OUTPUT_BYTES / 2]);
            assert_eq!(
                retained.end,
                output.as_bytes()[output.len() - MAX_OUTPUT_BYTES / 2..]
            );
            assert!(retained.truncated);
            assert_eq!(
                retained.start.capacity() + retained.end.capacity(),
                MAX_OUTPUT_BYTES
            );
            let text = retained.text();
            assert!(text.starts_with("early"));
            assert!(text.ends_with("late"));
            assert_eq!(text.len(), MAX_OUTPUT_BYTES + OUTPUT_OMITTED.len());
            assert!(text.contains(OUTPUT_OMITTED));
        }
    }

    #[test]
    fn failure_diagnostics_keep_each_stream_when_only_one_is_long() {
        let long = format!("early{}late", "x".repeat(MAX_OUTPUT_BYTES * 2));
        for (stdout, stderr) in [(long.as_str(), "short"), ("short", long.as_str())] {
            let diagnostic = failure_diagnostic(
                "Setup process exited with failure",
                &drain(stdout.as_bytes()).unwrap(),
                &drain(stderr.as_bytes()).unwrap(),
            );
            assert!(diagnostic.contains("early"));
            assert!(diagnostic.contains("late"));
            assert!(diagnostic.contains("short"));
            assert_eq!(diagnostic.chars().count(), MAX_DIAGNOSTIC_CHARS);
        }
    }
}
