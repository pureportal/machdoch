use std::{
    io::{BufReader, Read},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use super::{payload::cleanup_temporary_file, progress::emit_progress_from_stderr_line};

#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x00000008;

#[cfg(target_os = "windows")]
pub(super) const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[cfg(target_os = "windows")]
pub(super) const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(super) const SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES: usize = 1024 * 1024;
pub(super) const SUBPROCESS_OUTPUT_TRUNCATED_MARKER: &str =
    "[output truncated after capture limit]";

pub(super) fn read_stdout(stdout: impl Read) -> Result<String, String> {
    read_bounded_stream_text(stdout, "stdout")
}

pub(super) fn read_bounded_stream_text(
    mut stream: impl Read,
    stream_name: &str,
) -> Result<String, String> {
    let mut captured = Vec::with_capacity(SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES.min(8192));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];

    loop {
        let bytes_read = stream.read(&mut buffer).map_err(|error| {
            format!("Failed to read the shared CLI {stream_name} stream: {error}")
        })?;

        if bytes_read == 0 {
            break;
        }

        append_bounded_bytes(&mut captured, &buffer[..bytes_read], &mut truncated);
    }

    Ok(decode_bounded_output(captured, truncated))
}

fn append_bounded_bytes(captured: &mut Vec<u8>, bytes: &[u8], truncated: &mut bool) {
    if *truncated {
        return;
    }

    let remaining = SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES.saturating_sub(captured.len());

    if bytes.len() <= remaining {
        captured.extend_from_slice(bytes);
        return;
    }

    captured.extend_from_slice(&bytes[..remaining]);
    *truncated = true;
}

fn decode_bounded_output(captured: Vec<u8>, truncated: bool) -> String {
    let mut output = String::from_utf8_lossy(&captured).to_string();

    if truncated {
        append_truncation_marker(&mut output);
    }

    output
}

fn append_truncation_marker(output: &mut String) {
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }

    output.push_str(SUBPROCESS_OUTPUT_TRUNCATED_MARKER);
}

pub(super) type DesktopTaskActivity = Arc<Mutex<Instant>>;

pub(super) fn create_desktop_task_activity() -> DesktopTaskActivity {
    Arc::new(Mutex::new(Instant::now()))
}

pub(super) fn mark_desktop_task_activity(activity: &DesktopTaskActivity) {
    if let Ok(mut last_activity_at) = activity.lock() {
        *last_activity_at = Instant::now();
    }
}

pub(super) fn desktop_task_activity_elapsed(activity: &DesktopTaskActivity) -> Duration {
    activity
        .lock()
        .map(|last_activity_at| last_activity_at.elapsed())
        .unwrap_or(Duration::MAX)
}

fn read_stderr_lines(
    stderr: impl Read,
    activity: &DesktopTaskActivity,
    mut handle_progress_line: impl FnMut(&str) -> bool,
) -> Result<Vec<String>, String> {
    let mut stderr_lines = Vec::new();
    let mut retained_bytes = 0_usize;
    let mut diagnostics_truncated = false;
    let mut current_line = Vec::new();
    let mut current_line_truncated = false;
    let mut reader = BufReader::new(stderr);
    let mut buffer = [0_u8; 8192];

    loop {
        let bytes_read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read the shared CLI stderr stream: {error}"))?;

        if bytes_read == 0 {
            break;
        }

        for byte in &buffer[..bytes_read] {
            if *byte == b'\n' {
                process_stderr_line(
                    &mut stderr_lines,
                    &mut retained_bytes,
                    &mut diagnostics_truncated,
                    &current_line,
                    current_line_truncated,
                    activity,
                    &mut handle_progress_line,
                );
                current_line.clear();
                current_line_truncated = false;
            } else if current_line.len() < SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES {
                current_line.push(*byte);
            } else {
                current_line_truncated = true;
            }
        }
    }

    if !current_line.is_empty() || current_line_truncated {
        process_stderr_line(
            &mut stderr_lines,
            &mut retained_bytes,
            &mut diagnostics_truncated,
            &current_line,
            current_line_truncated,
            activity,
            &mut handle_progress_line,
        );
    }

    Ok(stderr_lines)
}

fn process_stderr_line(
    stderr_lines: &mut Vec<String>,
    retained_bytes: &mut usize,
    diagnostics_truncated: &mut bool,
    raw_line: &[u8],
    line_truncated: bool,
    activity: &DesktopTaskActivity,
    handle_progress_line: &mut impl FnMut(&str) -> bool,
) {
    let raw_line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
    let line = String::from_utf8_lossy(raw_line);
    let trimmed_line = line.trim();

    if trimmed_line.is_empty() && !line_truncated {
        return;
    }

    if !line_truncated && handle_progress_line(trimmed_line) {
        mark_desktop_task_activity(activity);
        return;
    }

    push_bounded_stderr_line(
        stderr_lines,
        retained_bytes,
        diagnostics_truncated,
        trimmed_line,
        line_truncated,
    );
}

fn push_bounded_stderr_line(
    stderr_lines: &mut Vec<String>,
    retained_bytes: &mut usize,
    diagnostics_truncated: &mut bool,
    line: &str,
    line_truncated: bool,
) {
    if *diagnostics_truncated {
        return;
    }

    let separator_bytes = if stderr_lines.is_empty() { 0 } else { 1 };
    let remaining = SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES
        .saturating_sub(*retained_bytes)
        .saturating_sub(separator_bytes);

    let mut retained_line = line.to_string();

    if line_truncated || retained_line.len() > remaining {
        truncate_string_to_byte_limit(&mut retained_line, remaining);
        append_truncation_marker(&mut retained_line);
        *diagnostics_truncated = true;
    }

    if retained_line.is_empty() {
        retained_line.push_str(SUBPROCESS_OUTPUT_TRUNCATED_MARKER);
    }

    *retained_bytes += separator_bytes + retained_line.len();
    stderr_lines.push(retained_line);
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

pub(super) fn read_stderr(
    stderr: impl Read,
    app_handle: tauri::AppHandle,
    window_label: String,
    task_id: Option<String>,
    activity: DesktopTaskActivity,
) -> Result<Vec<String>, String> {
    read_stderr_lines(stderr, &activity, |trimmed_line| {
        emit_progress_from_stderr_line(&app_handle, &window_label, task_id.as_deref(), trimmed_line)
    })
}

fn join_worker<T>(
    handle: thread::JoinHandle<Result<T, String>>,
    description: &str,
) -> Result<T, String> {
    match handle.join() {
        Ok(result) => result,
        Err(_) => Err(format!(
            "The shared CLI {description} worker terminated unexpectedly."
        )),
    }
}

pub(super) fn join_cli_output_and_cleanup(
    stdout_worker: thread::JoinHandle<Result<String, String>>,
    stderr_worker: thread::JoinHandle<Result<Vec<String>, String>>,
    conversation_context_path: Option<&std::path::PathBuf>,
) -> Result<(String, String), String> {
    let stdout_result = join_worker(stdout_worker, "stdout");
    let stderr_result = join_worker(stderr_worker, "stderr").map(|lines| lines.join("\n"));

    cleanup_temporary_file(conversation_context_path);

    Ok((stdout_result?, stderr_result?))
}

pub(super) fn terminate_child_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let mut command = Command::new("taskkill");
        hide_child_process_window(&mut command);
        let taskkill_result = command
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
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

pub(super) fn hide_child_process_window(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

fn spawn_detached_command(command: &mut Command, error_prefix: &str) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("{error_prefix}: {error}"))
}

pub(super) fn open_path_in_system_shell(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");

        if path.is_file() {
            command.arg(format!("/select,{}", path.display()));
        } else {
            command.arg(path);
        }

        return spawn_detached_command(
            &mut command,
            "Windows Explorer could not open the requested path",
        );
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");

        if path.is_file() {
            command.arg("-R");
        }

        command.arg(path);

        return spawn_detached_command(&mut command, "Finder could not open the requested path");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };

        let mut command = Command::new("xdg-open");
        command.arg(target);

        return spawn_detached_command(
            &mut command,
            "The system file browser could not open the requested path",
        );
    }

    #[allow(unreachable_code)]
    Err("Opening workspace paths is not supported on this platform.".to_string())
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Cursor, thread, time::Duration};

    use serde_json::json;

    use super::{
        create_desktop_task_activity, desktop_task_activity_elapsed, join_cli_output_and_cleanup,
        mark_desktop_task_activity, read_stderr_lines, read_stdout,
        SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES, SUBPROCESS_OUTPUT_TRUNCATED_MARKER,
    };
    use crate::desktop_task::payload::write_conversation_context_file;

    #[test]
    fn desktop_output_join_cleans_context_file_after_workers_finish() {
        let context = json!({ "history": [] });
        let context_path =
            write_conversation_context_file(&context).expect("context file should be created");
        let stdout_worker = thread::spawn(|| Ok("stdout".to_string()));
        let stderr_worker = thread::spawn(|| Ok(vec!["stderr".to_string()]));

        let output = join_cli_output_and_cleanup(stdout_worker, stderr_worker, Some(&context_path))
            .expect("output should join cleanly");

        assert_eq!(output, ("stdout".to_string(), "stderr".to_string()));
        assert!(!context_path.exists());
    }

    #[test]
    fn desktop_output_join_cleans_context_file_when_worker_fails() {
        let context = json!({ "history": [] });
        let context_path =
            write_conversation_context_file(&context).expect("context file should be created");
        let stdout_worker = thread::spawn(|| Err::<String, String>("stdout failed".to_string()));
        let stderr_worker = thread::spawn(|| Ok(Vec::<String>::new()));

        let result = join_cli_output_and_cleanup(stdout_worker, stderr_worker, Some(&context_path));

        assert!(result
            .expect_err("worker failure should be returned")
            .contains("stdout failed"));
        assert!(!context_path.exists());
        let _ = fs::remove_file(context_path);
    }

    #[test]
    fn desktop_task_activity_tracks_elapsed_time_since_last_progress() {
        let activity = create_desktop_task_activity();

        thread::sleep(Duration::from_millis(15));
        let elapsed_before_progress = desktop_task_activity_elapsed(&activity);

        mark_desktop_task_activity(&activity);
        let elapsed_after_progress = desktop_task_activity_elapsed(&activity);

        assert!(elapsed_before_progress >= Duration::from_millis(10));
        assert!(elapsed_after_progress < elapsed_before_progress);
    }

    #[test]
    fn stderr_reader_marks_activity_for_structured_progress_lines() {
        let activity = create_desktop_task_activity();

        thread::sleep(Duration::from_millis(15));
        let elapsed_before_progress = desktop_task_activity_elapsed(&activity);

        let stderr_lines = read_stderr_lines(
            Cursor::new("ordinary stderr\nmachdoch-progress: {\"state\":\"running\"}\n"),
            &activity,
            |line| line.starts_with("machdoch-progress: "),
        )
        .expect("stderr should be read");

        assert_eq!(stderr_lines, vec!["ordinary stderr".to_string()]);
        assert!(desktop_task_activity_elapsed(&activity) < elapsed_before_progress);
    }

    #[test]
    fn stdout_reader_caps_retained_output_and_marks_truncation() {
        let output = read_stdout(Cursor::new(vec![
            b'x';
            SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES + 128
        ]))
        .expect("stdout should be read");

        assert!(output.len() < SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES + 256);
        assert!(output.contains(SUBPROCESS_OUTPUT_TRUNCATED_MARKER));
        assert!(std::str::from_utf8(output.as_bytes()).is_ok());
    }

    #[test]
    fn stderr_reader_caps_non_progress_diagnostics() {
        let activity = create_desktop_task_activity();
        let stderr_lines = read_stderr_lines(
            Cursor::new(vec![b'e'; SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES + 128]),
            &activity,
            |_| false,
        )
        .expect("stderr should be read");
        let stderr_text = stderr_lines.join("\n");

        assert!(stderr_text.len() < SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES + 256);
        assert!(stderr_text.contains(SUBPROCESS_OUTPUT_TRUNCATED_MARKER));
        assert!(std::str::from_utf8(stderr_text.as_bytes()).is_ok());
    }
}
