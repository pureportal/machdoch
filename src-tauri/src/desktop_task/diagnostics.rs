const COMMAND_DIAGNOSTIC_LIMIT_BYTES: usize = 16 * 1024;
pub(super) const COMMAND_DIAGNOSTIC_TRUNCATED_MARKER: &str =
    "[diagnostic output truncated after display limit]";

pub(super) fn format_command_failure(stderr: &str, stdout: &str) -> String {
    let stderr_text = sanitize_command_diagnostics(stderr);

    if !stderr_text.is_empty() {
        return format_diagnostic_snippet(&stderr_text);
    }

    let stdout_text = sanitize_command_diagnostics(stdout);

    if !stdout_text.is_empty() {
        return format_diagnostic_snippet(&stdout_text);
    }

    "The shared CLI exited without additional diagnostics.".to_string()
}

pub(super) fn format_diagnostic_snippet(value: &str) -> String {
    let mut snippet = value.trim().to_string();

    if snippet.len() <= COMMAND_DIAGNOSTIC_LIMIT_BYTES {
        return snippet;
    }

    truncate_string_to_byte_limit(&mut snippet, COMMAND_DIAGNOSTIC_LIMIT_BYTES);

    if !snippet.is_empty() && !snippet.ends_with('\n') {
        snippet.push('\n');
    }

    snippet.push_str(COMMAND_DIAGNOSTIC_TRUNCATED_MARKER);
    snippet
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

fn truncate_string_to_byte_limit(value: &mut String, limit: usize) {
    if value.len() <= limit {
        return;
    }

    let mut end = limit;

    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }

    value.truncate(end);
}

#[cfg(test)]
mod tests {
    use super::{
        format_command_failure, format_diagnostic_snippet, format_timeout_duration,
        COMMAND_DIAGNOSTIC_TRUNCATED_MARKER,
    };

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

    #[test]
    fn diagnostic_snippet_caps_oversized_text_at_utf8_boundary() {
        let message = format_diagnostic_snippet(&"é".repeat(20 * 1024));

        assert!(message.contains(COMMAND_DIAGNOSTIC_TRUNCATED_MARKER));
        assert!(message.len() < 17 * 1024);
        assert!(std::str::from_utf8(message.as_bytes()).is_ok());
    }

    #[test]
    fn command_failure_diagnostics_are_bounded() {
        let message = format_command_failure(&"stderr line\n".repeat(20 * 1024), "");

        assert!(message.contains(COMMAND_DIAGNOSTIC_TRUNCATED_MARKER));
        assert!(message.len() < 17 * 1024);
    }
}
