pub(super) fn format_command_failure(stderr: &str, stdout: &str) -> String {
    let stderr_text = sanitize_command_diagnostics(stderr);

    if !stderr_text.is_empty() {
        return stderr_text;
    }

    let stdout_text = sanitize_command_diagnostics(stdout);

    if !stdout_text.is_empty() {
        return stdout_text;
    }

    "The shared CLI exited without additional diagnostics.".to_string()
}

pub(super) fn format_timeout_duration(timeout_ms: u64) -> String {
    if timeout_ms % (60 * 60 * 1_000) == 0 {
        let hours = timeout_ms / (60 * 60 * 1_000);
        return format!("{hours} hour{}", if hours == 1 { "" } else { "s" });
    }

    if timeout_ms % (60 * 1_000) == 0 {
        let minutes = timeout_ms / (60 * 1_000);
        return format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" });
    }

    let seconds = timeout_ms / 1_000;
    format!("{seconds} second{}", if seconds == 1 { "" } else { "s" })
}

fn sanitize_command_diagnostics(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && *line != "Debugger attached."
                && *line != "Waiting for the debugger to disconnect..."
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::{format_command_failure, format_timeout_duration};

    #[test]
    fn command_failure_diagnostics_strip_node_debugger_noise() {
        let message = format_command_failure(
            "Debugger attached.\nmachdoch: Ralph flow `ralph-flow` is invalid.\nWaiting for the debugger to disconnect...\n",
            "",
        );

        assert_eq!(message, "machdoch: Ralph flow `ralph-flow` is invalid.");
    }

    #[test]
    fn timeout_duration_uses_largest_even_unit() {
        assert_eq!(format_timeout_duration(12 * 60 * 60 * 1_000), "12 hours");
        assert_eq!(format_timeout_duration(20 * 60 * 1_000), "20 minutes");
        assert_eq!(format_timeout_duration(5 * 1_000), "5 seconds");
    }
}
