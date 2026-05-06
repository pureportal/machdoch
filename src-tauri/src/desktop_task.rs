use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::Emitter;

use crate::runtime_snapshot::{normalize_optional_string, resolve_workspace_root_path};

const DESKTOP_TASK_PROGRESS_EVENT: &str = "desktop-task-progress";
const DESKTOP_TASK_TIMEOUT_MS: u64 = 20 * 60 * 1_000;
const DESKTOP_TASK_WAIT_POLL_MS: u64 = 250;

#[derive(Default)]
pub struct DesktopTaskCancelState {
    active: HashMap<String, Arc<AtomicBool>>,
    pending: HashSet<String>,
}

pub struct DesktopTaskCancelMap(pub Mutex<DesktopTaskCancelState>);

impl Default for DesktopTaskCancelMap {
    fn default() -> Self {
        Self(Mutex::new(DesktopTaskCancelState::default()))
    }
}

#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x00000008;

#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTaskRunResponse {
    execution: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTaskRunRequest {
    workspace_root: String,
    task: String,
    mode: Option<String>,
    profile: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    conversation_context: Option<Value>,
    task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedPathEntry {
    path: String,
    kind: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedPathsResolution {
    entries: Vec<DroppedPathEntry>,
    workspace_root: Option<String>,
}

struct CliCommandOptions<'a> {
    workspace_root: &'a str,
    task: &'a str,
    mode: Option<&'a str>,
    profile: Option<&'a str>,
    provider: Option<&'a str>,
    model: Option<&'a str>,
    conversation_context_file: Option<&'a Path>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTaskProgressEvent {
    task_id: String,
    line: String,
    timestamp: u64,
}

fn format_command_failure(stderr: &str, stdout: &str) -> String {
    let stderr_text = stderr.trim().to_string();

    if !stderr_text.is_empty() {
        return stderr_text;
    }

    let stdout_text = stdout.trim().to_string();

    if !stdout_text.is_empty() {
        return stdout_text;
    }

    "The shared CLI exited without additional diagnostics.".to_string()
}

fn build_cli_args(options: CliCommandOptions<'_>) -> Vec<String> {
    let mut args = vec![
        "--quick".to_string(),
        "--json".to_string(),
        "--verbose".to_string(),
        "--cwd".to_string(),
        options.workspace_root.to_string(),
        "--task".to_string(),
        options.task.to_string(),
    ];

    if let Some(mode) = options.mode {
        args.push("--mode".to_string());
        args.push(mode.to_string());
    }

    if let Some(profile) = options.profile {
        args.push("--profile".to_string());
        args.push(profile.to_string());
    }

    if let Some(provider) = options.provider {
        args.push("--runtime-provider".to_string());
        args.push(provider.to_string());
    }

    if let Some(model) = options.model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    if let Some(conversation_context_file) = options.conversation_context_file {
        args.push("--conversation-context-file".to_string());
        args.push(conversation_context_file.display().to_string());
    }

    args
}

fn write_conversation_context_file(conversation_context: &Value) -> Result<PathBuf, String> {
    let file_path = env::temp_dir().join(format!(
        "machdoch-desktop-context-{}.json",
        create_progress_timestamp()
    ));
    let serialized = serde_json::to_string(conversation_context)
        .map_err(|error| format!("Failed to serialize conversation context: {error}"))?;

    fs::write(&file_path, serialized).map_err(|error| {
        format!(
            "Failed to write the desktop conversation context file {}: {error}",
            file_path.display()
        )
    })?;

    Ok(file_path)
}

fn cleanup_temporary_file(path: Option<&PathBuf>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

fn format_path_for_ui(path: &Path) -> String {
    path.display().to_string()
}

fn classify_dropped_path(raw_path: &str) -> Option<DroppedPathEntry> {
    let normalized_path = raw_path.trim();

    if normalized_path.is_empty() {
        return None;
    }

    let candidate_path = PathBuf::from(normalized_path);
    let display_path = candidate_path
        .canonicalize()
        .unwrap_or_else(|_| candidate_path.clone());
    let metadata = fs::metadata(&display_path).or_else(|_| fs::metadata(&candidate_path));
    let kind = metadata
        .as_ref()
        .map(|metadata| {
            if metadata.is_dir() {
                "directory"
            } else if metadata.is_file() {
                "file"
            } else {
                "other"
            }
        })
        .unwrap_or("other")
        .to_string();
    let name = display_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| format_path_for_ui(&display_path));
    let parent = display_path.parent().map(format_path_for_ui);

    Some(DroppedPathEntry {
        path: format_path_for_ui(&display_path),
        kind,
        name,
        parent,
    })
}

fn resolve_dropped_paths_sync(paths: Vec<String>) -> DroppedPathsResolution {
    let mut seen_paths = HashSet::new();
    let mut entries = Vec::new();

    for path in paths {
        let Some(entry) = classify_dropped_path(&path) else {
            continue;
        };
        let dedupe_key = entry.path.to_lowercase();

        if !seen_paths.insert(dedupe_key) {
            continue;
        }

        entries.push(entry);
    }

    let workspace_root = entries
        .iter()
        .find(|entry| entry.kind == "directory")
        .map(|entry| entry.path.clone())
        .or_else(|| entries.iter().find_map(|entry| entry.parent.clone()));

    DroppedPathsResolution {
        entries,
        workspace_root,
    }
}

fn enrich_ui_control_conversation_context(
    conversation_context: Option<Value>,
) -> Result<Option<Value>, String> {
    let Some(mut conversation_context) = conversation_context else {
        return Ok(None);
    };

    let Value::Object(context_object) = &mut conversation_context else {
        return Err("Expected the desktop conversation context to be a JSON object.".to_string());
    };

    if context_object
        .get("uiControlEnabled")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok(Some(conversation_context));
    }

    let runtime_info = serde_json::to_value(crate::ui_control::create_ui_control_runtime_info())
        .map_err(|error| format!("Failed to serialize desktop UI control metadata: {error}"))?;

    let ui_control_value = match context_object.get_mut("uiControl") {
        Some(Value::Object(existing)) => {
            let mut merged = match runtime_info {
                Value::Object(object) => object,
                _ => Map::new(),
            };

            for (key, value) in existing.clone() {
                if key != "bridgeCommand" {
                    merged.insert(key, value);
                }
            }

            Value::Object(merged)
        }
        _ => runtime_info,
    };

    context_object.insert("uiControl".to_string(), ui_control_value);

    Ok(Some(conversation_context))
}

fn create_progress_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_progress_line(line: &str) -> Option<String> {
    let trimmed = line.trim();

    if trimmed.is_empty() {
        return None;
    }

    Some(
        trimmed
            .strip_prefix("machdoch: ")
            .unwrap_or(trimmed)
            .trim()
            .to_string(),
    )
}

fn emit_progress_line(
    app_handle: &tauri::AppHandle,
    window_label: &str,
    task_id: Option<&str>,
    line: &str,
) {
    let Some(task_id) = task_id else {
        return;
    };

    let Some(normalized_line) = normalize_progress_line(line) else {
        return;
    };

    let _ = app_handle.emit_to(
        window_label,
        DESKTOP_TASK_PROGRESS_EVENT,
        DesktopTaskProgressEvent {
            task_id: task_id.to_string(),
            line: normalized_line,
            timestamp: create_progress_timestamp(),
        },
    );
}

fn read_stdout(stdout: impl Read) -> Result<String, String> {
    let mut output = String::new();

    BufReader::new(stdout)
        .read_to_string(&mut output)
        .map_err(|error| format!("Failed to read the shared CLI stdout stream: {error}"))?;

    Ok(output)
}

fn read_stderr(
    stderr: impl Read,
    app_handle: tauri::AppHandle,
    window_label: String,
    task_id: Option<String>,
) -> Result<Vec<String>, String> {
    let mut stderr_lines = Vec::new();

    for line in BufReader::new(stderr).lines() {
        let line =
            line.map_err(|error| format!("Failed to read the shared CLI stderr stream: {error}"))?;

        let trimmed_line = line.trim();

        if trimmed_line.is_empty() {
            continue;
        }

        emit_progress_line(&app_handle, &window_label, task_id.as_deref(), trimmed_line);
        stderr_lines.push(trimmed_line.to_string());
    }

    Ok(stderr_lines)
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

fn parse_desktop_task_response(stdout: &str) -> Result<DesktopTaskRunResponse, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<DesktopTaskRunResponse>(trimmed_stdout).map_err(|error| {
        format!("Failed to parse the shared CLI JSON response: {error}. Output: {trimmed_stdout}")
    })
}

fn execute_desktop_task(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: DesktopTaskRunRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<DesktopTaskRunResponse, String> {
    let DesktopTaskRunRequest {
        workspace_root,
        task,
        mode,
        profile,
        provider,
        model,
        conversation_context,
        task_id,
    } = request;
    let workspace_path = resolve_workspace_root_path(&workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();

    let normalized_task = task.trim();

    if normalized_task.is_empty() {
        return Err("Expected a non-empty task before running the desktop executor.".to_string());
    }

    let normalized_provider = normalize_optional_string(provider.as_deref());
    let normalized_mode = normalize_optional_string(mode.as_deref());
    let normalized_profile = normalize_optional_string(profile.as_deref());
    let normalized_model = normalize_optional_string(model.as_deref());
    let conversation_context = enrich_ui_control_conversation_context(conversation_context)?;
    let conversation_context_path = conversation_context
        .as_ref()
        .map(write_conversation_context_file)
        .transpose()?;

    let cli_args = build_cli_args(CliCommandOptions {
        workspace_root: &normalized_workspace_root,
        task: normalized_task,
        mode: normalized_mode.as_deref(),
        profile: normalized_profile.as_deref(),
        provider: normalized_provider.as_deref(),
        model: normalized_model.as_deref(),
        conversation_context_file: conversation_context_path.as_deref(),
    });
    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;

    cli_command
        .command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cli_command.command.spawn().map_err(|error| {
        cleanup_temporary_file(conversation_context_path.as_ref());

        format!(
            "Failed to launch the shared CLI. {} {error}",
            crate::shared_cli::cli_runtime_error_hint()
        )
    })?;

    let stdout = child.stdout.take().ok_or_else(|| {
        cleanup_temporary_file(conversation_context_path.as_ref());
        "The shared CLI did not expose a stdout stream for the desktop bridge.".to_string()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        cleanup_temporary_file(conversation_context_path.as_ref());
        "The shared CLI did not expose a stderr stream for the desktop bridge.".to_string()
    })?;
    let progress_app_handle = app_handle.clone();
    let progress_window_label = window_label.clone();
    let progress_task_id = task_id.clone();

    let stdout_worker = thread::spawn(move || read_stdout(stdout));
    let stderr_worker =
        thread::spawn(move || read_stderr(stderr, app_handle, window_label, task_id));

    let started_at = Instant::now();
    let status = loop {
        match child
            .try_wait()
            .map_err(|error| format!("Failed to wait for the shared CLI to finish: {error}"))?
        {
            Some(status) => break status,
            None => {
                if cancel_flag.load(Ordering::SeqCst) {
                    emit_progress_line(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        "machdoch: Cancelled by user; stopping the task.",
                    );

                    let _ = child.kill();
                    let _ = child.wait();

                    let stdout_text = join_worker(stdout_worker, "stdout")?;
                    let stderr_text = join_worker(stderr_worker, "stderr")?.join("\n");

                    cleanup_temporary_file(conversation_context_path.as_ref());

                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);
                    return Err(format!("The task was cancelled. {}", failure_tail));
                }

                if started_at.elapsed() >= Duration::from_millis(DESKTOP_TASK_TIMEOUT_MS) {
                    emit_progress_line(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        "machdoch: execution exceeded the desktop safety timeout; stopping the task.",
                    );

                    let _ = child.kill();
                    let _ = child.wait();

                    let stdout_text = join_worker(stdout_worker, "stdout")?;
                    let stderr_text = join_worker(stderr_worker, "stderr")?.join("\n");

                    cleanup_temporary_file(conversation_context_path.as_ref());

                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);
                    return Err(format!(
                        "The shared CLI exceeded the desktop safety timeout of {} minutes and was stopped. {}",
                        DESKTOP_TASK_TIMEOUT_MS / 60_000,
                        failure_tail
                    ));
                }

                thread::sleep(Duration::from_millis(DESKTOP_TASK_WAIT_POLL_MS));
            }
        }
    };
    let stdout_text = join_worker(stdout_worker, "stdout")?;
    let stderr_text = join_worker(stderr_worker, "stderr")?.join("\n");

    if !stdout_text.trim().is_empty() {
        if let Ok(response) = parse_desktop_task_response(&stdout_text) {
            cleanup_temporary_file(conversation_context_path.as_ref());
            return Ok(response);
        }
    }

    if !status.success() {
        cleanup_temporary_file(conversation_context_path.as_ref());
        return Err(format!(
            "The shared CLI could not complete the task. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    let response = parse_desktop_task_response(&stdout_text);

    cleanup_temporary_file(conversation_context_path.as_ref());

    response
}

fn resolve_workspace_relative_path(
    workspace_root: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let normalized_relative_path = relative_path.trim();

    if normalized_relative_path.is_empty() {
        return Err("Expected a workspace-relative path to open.".to_string());
    }

    let workspace_path = resolve_workspace_root_path(workspace_root)?;

    let candidate_relative_path = PathBuf::from(normalized_relative_path);

    if candidate_relative_path.is_absolute() {
        return Err("Expected a workspace-relative path, not an absolute path.".to_string());
    }

    let resolved_path = workspace_path
        .join(&candidate_relative_path)
        .canonicalize()
        .map_err(|error| {
            format!("Unable to resolve `{normalized_relative_path}` inside the workspace: {error}")
        })?;

    if !resolved_path.starts_with(&workspace_path) {
        return Err("Refused to open a path outside the active workspace.".to_string());
    }

    Ok(resolved_path)
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

fn open_path_in_system_shell(path: &Path) -> Result<(), String> {
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

#[tauri::command]
pub async fn cancel_desktop_task(
    state: tauri::State<'_, DesktopTaskCancelMap>,
    task_id: String,
) -> Result<(), String> {
    if let Ok(mut cancel_state) = state.0.lock() {
        if let Some(cancel_flag) = cancel_state.active.get(&task_id) {
            cancel_flag.store(true, Ordering::SeqCst);
        } else {
            cancel_state.pending.insert(task_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_active_desktop_task_ids(
    state: tauri::State<'_, DesktopTaskCancelMap>,
) -> Result<Vec<String>, String> {
    let cancel_state = state.0.lock().map_err(|_| {
        "Unable to inspect active desktop tasks because the task registry lock is unavailable."
            .to_string()
    })?;
    let mut task_ids = cancel_state.active.keys().cloned().collect::<Vec<_>>();

    task_ids.sort();

    Ok(task_ids)
}

#[tauri::command]
pub async fn run_desktop_task(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DesktopTaskCancelMap>,
    window: tauri::WebviewWindow,
    request: DesktopTaskRunRequest,
) -> Result<DesktopTaskRunResponse, String> {
    let window_label = window.label().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let task_id = request.task_id.clone();

    if let Some(id) = &request.task_id {
        if let Ok(mut cancel_state) = state.0.lock() {
            if cancel_state.pending.remove(id) {
                cancel_flag.store(true, Ordering::SeqCst);
            }

            cancel_state.active.insert(id.clone(), cancel_flag.clone());
        }
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        execute_desktop_task(app_handle, window_label, request, cancel_flag)
    })
    .await
    .map_err(|error| format!("The desktop task bridge stopped unexpectedly. {error}"));

    if let Some(id) = &task_id {
        if let Ok(mut cancel_state) = state.0.lock() {
            cancel_state.active.remove(id);
            cancel_state.pending.remove(id);
        }
    }

    result?
}

#[tauri::command]
pub async fn open_workspace_path(
    workspace_root: String,
    relative_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved_path = resolve_workspace_relative_path(&workspace_root, &relative_path)?;
        open_path_in_system_shell(&resolved_path)
    })
    .await
    .map_err(|error| format!("The workspace path opener stopped unexpectedly. {error}"))?
}

#[tauri::command]
pub async fn resolve_dropped_paths(paths: Vec<String>) -> Result<DroppedPathsResolution, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_dropped_paths_sync(paths))
        .await
        .map_err(|error| format!("The dropped path resolver stopped unexpectedly. {error}"))
}

#[cfg(test)]
mod tests {
    use super::{build_cli_args, CliCommandOptions};

    #[test]
    fn desktop_cli_args_force_one_shot_json_execution() {
        let args = build_cli_args(CliCommandOptions {
            workspace_root: "C:/workspace",
            task: "How is the weather?",
            mode: Some("ask"),
            profile: None,
            provider: Some("openai"),
            model: Some("gpt-5.2"),
            conversation_context_file: None,
        });

        assert_eq!(args[0], "--quick");
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"--task".to_string()));
        assert!(args.contains(&"How is the weather?".to_string()));
    }
}
