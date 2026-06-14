use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::Emitter;

use crate::runtime_snapshot::{normalize_optional_string, resolve_workspace_root_path};

const DESKTOP_TASK_PROGRESS_EVENT: &str = "desktop-task-progress";
const CLI_STRUCTURED_PROGRESS_PREFIX: &str = "machdoch-progress: ";
const DESKTOP_TASK_TIMEOUT_MS: u64 = 20 * 60 * 1_000;
const DESKTOP_TASK_WAIT_POLL_MS: u64 = 250;
const MAX_PENDING_CANCEL_IDS: usize = 256;
const MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_ATTACHMENT_PATH_GRANTS: usize = 1024;

static TEMP_FILE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Default)]
pub struct DesktopTaskCancelState {
    active: HashMap<String, ActiveDesktopTask>,
    pending: HashSet<String>,
}

pub struct DesktopTaskCancelMap(pub Mutex<DesktopTaskCancelState>);

impl Default for DesktopTaskCancelMap {
    fn default() -> Self {
        Self(Mutex::new(DesktopTaskCancelState::default()))
    }
}

#[derive(Default)]
pub struct AttachmentPathGrantMap(pub Mutex<HashSet<PathBuf>>);

struct ActiveDesktopTask {
    cancel_flag: Arc<AtomicBool>,
    kind: String,
    workspace_root: String,
    arguments: Vec<String>,
    started_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDesktopTaskSummary {
    id: String,
    kind: String,
    workspace_root: String,
    arguments: Vec<String>,
    started_at: u64,
}

#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x00000008;

#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    reasoning: Option<String>,
    conversation_context: Option<Value>,
    image_paths: Option<Vec<String>>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImageAttachmentRequest {
    data_base64: String,
    media_type: String,
    file_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerCommandRequest {
    workspace_root: String,
    arguments: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RalphCommandRequest {
    workspace_root: String,
    arguments: Vec<String>,
    task_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCommandRequest {
    workspace_root: String,
    arguments: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionCommandRequest {
    workspace_root: String,
    arguments: Vec<String>,
}

struct CliCommandOptions<'a> {
    workspace_root: &'a str,
    task: &'a str,
    mode: Option<&'a str>,
    profile: Option<&'a str>,
    provider: Option<&'a str>,
    model: Option<&'a str>,
    reasoning: Option<&'a str>,
    conversation_context_file: Option<&'a Path>,
    image_paths: &'a [String],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTaskProgressEvent {
    task_id: String,
    progress: Value,
    timestamp: u64,
}

fn format_command_failure(stderr: &str, stdout: &str) -> String {
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

    if let Some(reasoning) = options.reasoning {
        args.push("--reasoning".to_string());
        args.push(reasoning.to_string());
    }

    if let Some(conversation_context_file) = options.conversation_context_file {
        args.push("--conversation-context-file".to_string());
        args.push(conversation_context_file.display().to_string());
    }

    for image_path in options.image_paths {
        args.push("--image".to_string());
        args.push(image_path.to_string());
    }

    args
}

fn write_conversation_context_file(conversation_context: &Value) -> Result<PathBuf, String> {
    let unique_id = TEMP_FILE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let file_path = env::temp_dir().join(format!(
        "machdoch-desktop-context-{}-{}-{}.json",
        std::process::id(),
        create_progress_timestamp(),
        unique_id
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

fn cleanup_temporary_files(paths: &[PathBuf]) {
    for path in paths {
        cleanup_temporary_file(Some(path));
    }
}

fn write_workspace_payload_file(
    workspace_root: &str,
    label: &str,
    contents: &str,
) -> Result<PathBuf, String> {
    let unique_id = TEMP_FILE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let directory = Path::new(workspace_root)
        .join(".machdoch")
        .join("ralph")
        .join("payloads");
    let file_path = directory.join(format!(
        ".machdoch-ralph-{label}-{}-{}-{}.tmp",
        std::process::id(),
        create_progress_timestamp(),
        unique_id
    ));

    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Failed to prepare the Ralph payload directory {}: {error}",
            directory.display()
        )
    })?;
    fs::write(&file_path, contents).map_err(|error| {
        format!(
            "Failed to write the Ralph payload file {}: {error}",
            file_path.display()
        )
    })?;

    Ok(file_path)
}

fn rewrite_ralph_payload_arguments(
    workspace_root: &str,
    arguments: Vec<String>,
) -> Result<(Vec<String>, Vec<PathBuf>), String> {
    let mut rewritten = Vec::new();
    let mut payload_paths = Vec::new();
    let mut params = Vec::new();
    let mut index = 0;

    while index < arguments.len() {
        let argument = &arguments[index];
        let replacement_flag = match argument.as_str() {
            "--prompt" => Some(("--prompt-file", "prompt")),
            "--flow-json" => Some(("--flow-json-file", "flow-json")),
            "--existing-flow-json" => Some(("--existing-flow-json-file", "existing-flow-json")),
            _ => None,
        };

        if let Some((flag, label)) = replacement_flag {
            let Some(value) = arguments.get(index + 1) else {
                cleanup_temporary_files(&payload_paths);
                return Err(format!("Expected {argument} to include a value."));
            };
            let path = match write_workspace_payload_file(workspace_root, label, value) {
                Ok(path) => path,
                Err(error) => {
                    cleanup_temporary_files(&payload_paths);
                    return Err(error);
                }
            };
            rewritten.push(flag.to_string());
            rewritten.push(path.display().to_string());
            payload_paths.push(path);
            index += 2;
            continue;
        }

        if argument == "--param" {
            let Some(value) = arguments.get(index + 1) else {
                cleanup_temporary_files(&payload_paths);
                return Err("Expected --param to include a value.".to_string());
            };
            params.push(value.clone());
            index += 2;
            continue;
        }

        rewritten.push(argument.clone());
        index += 1;
    }

    if !params.is_empty() {
        let serialized = serde_json::to_string(&params)
            .map_err(|error| format!("Failed to serialize Ralph params: {error}"))?;
        let path = match write_workspace_payload_file(workspace_root, "params", &serialized) {
            Ok(path) => path,
            Err(error) => {
                cleanup_temporary_files(&payload_paths);
                return Err(error);
            }
        };
        rewritten.push("--params-file".to_string());
        rewritten.push(path.display().to_string());
        payload_paths.push(path);
    }

    Ok((rewritten, payload_paths))
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

fn remember_attachment_path_grant(
    grants: &AttachmentPathGrantMap,
    path: &str,
) -> Result<(), String> {
    let normalized_path = path.trim();

    if normalized_path.is_empty() {
        return Ok(());
    }

    let candidate_path = PathBuf::from(normalized_path);

    if !candidate_path.is_absolute() {
        return Ok(());
    }

    let resolved_path = candidate_path
        .canonicalize()
        .map_err(|error| format!("Unable to resolve trusted attachment path `{path}`: {error}"))?;
    let metadata = fs::metadata(&resolved_path).map_err(|error| {
        format!(
            "Unable to inspect trusted attachment path `{}`: {error}",
            resolved_path.display()
        )
    })?;

    if !metadata.is_file() && !metadata.is_dir() {
        return Ok(());
    }

    let mut granted_paths = grants
        .0
        .lock()
        .map_err(|_| "Unable to update trusted attachment paths.".to_string())?;

    if granted_paths.len() >= MAX_ATTACHMENT_PATH_GRANTS {
        if let Some(path_to_remove) = granted_paths.iter().next().cloned() {
            granted_paths.remove(&path_to_remove);
        }
    }

    granted_paths.insert(resolved_path);

    Ok(())
}

fn remember_dropped_path_grants(
    grants: &AttachmentPathGrantMap,
    resolution: &DroppedPathsResolution,
) -> Result<(), String> {
    for entry in &resolution.entries {
        remember_attachment_path_grant(grants, &entry.path)?;
    }

    Ok(())
}

fn attachment_path_is_granted(
    grants: &AttachmentPathGrantMap,
    path: &Path,
) -> Result<bool, String> {
    let granted_paths = grants
        .0
        .lock()
        .map_err(|_| "Unable to inspect trusted attachment paths.".to_string())?;

    Ok(granted_paths.contains(path))
}

fn clipboard_image_extension(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "image/gif" => Some("gif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn sanitize_clipboard_image_file_stem(file_name: Option<&str>) -> String {
    let raw_stem = file_name
        .and_then(|name| Path::new(name).file_stem())
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "clipboard-image".to_string());
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let normalized = sanitized.trim_matches(&['-', '.'][..]).trim();

    if normalized.is_empty() {
        "clipboard-image".to_string()
    } else {
        normalized.to_string()
    }
}

fn base64_decoded_len_upper_bound(value: &str) -> usize {
    let normalized = value.trim();
    let full_chunks = normalized.len() / 4;
    let remainder = normalized.len() % 4;
    let remainder_bytes = match remainder {
        0 => 0,
        2 => 1,
        3 => 2,
        _ => 3,
    };
    let padding = normalized
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count()
        .min(2);

    full_chunks
        .saturating_mul(3)
        .saturating_add(remainder_bytes)
        .saturating_sub(padding)
}

fn clipboard_image_attachment_directory() -> PathBuf {
    env::temp_dir().join("machdoch").join("clipboard-images")
}

fn save_clipboard_image_attachment_sync(
    request: ClipboardImageAttachmentRequest,
) -> Result<String, String> {
    let extension = clipboard_image_extension(&request.media_type).ok_or_else(|| {
        format!(
            "Unsupported clipboard image media type `{}`.",
            request.media_type.trim()
        )
    })?;
    let encoded_image = request.data_base64.trim();

    if base64_decoded_len_upper_bound(encoded_image) > MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES {
        return Err(format!(
            "Clipboard image data is too large. Maximum supported size is {} MiB.",
            MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }

    let image_bytes = BASE64_STANDARD
        .decode(encoded_image)
        .map_err(|error| format!("Failed to decode clipboard image data: {error}"))?;

    if image_bytes.is_empty() {
        return Err("Clipboard image data was empty.".to_string());
    }

    if image_bytes.len() > MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES {
        return Err(format!(
            "Clipboard image data is too large. Maximum supported size is {} MiB.",
            MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }

    let output_directory = clipboard_image_attachment_directory();
    fs::create_dir_all(&output_directory).map_err(|error| {
        format!(
            "Failed to create clipboard image directory {}: {error}",
            output_directory.display()
        )
    })?;

    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let file_stem = sanitize_clipboard_image_file_stem(request.file_name.as_deref());
    let output_path = output_directory.join(format!(
        "{file_stem}-{timestamp_ms}-{}.{}",
        std::process::id(),
        extension
    ));

    fs::write(&output_path, image_bytes).map_err(|error| {
        format!(
            "Failed to save clipboard image attachment {}: {error}",
            output_path.display()
        )
    })?;

    Ok(format_path_for_ui(&output_path))
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

fn parse_structured_progress_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();

    let payload = trimmed.strip_prefix(CLI_STRUCTURED_PROGRESS_PREFIX)?;

    match serde_json::from_str(payload.trim()).ok()? {
        Value::Object(progress) => Some(Value::Object(progress)),
        _ => None,
    }
}

fn create_bridge_progress(
    task: &str,
    mode: Option<&str>,
    state: &str,
    message: &str,
    cancellable: bool,
) -> Value {
    json!({
        "task": task,
        "mode": mode.unwrap_or("machdoch"),
        "state": state,
        "message": message,
        "executedTools": [],
        "outputSections": [],
        "cancellable": cancellable,
    })
}

fn emit_progress_event(
    app_handle: &tauri::AppHandle,
    window_label: &str,
    task_id: Option<&str>,
    progress: Value,
) {
    let Some(task_id) = task_id else {
        return;
    };
    let timestamp = create_progress_timestamp();

    crate::remote_control::record_task_progress(app_handle, task_id, &progress, timestamp);

    let _ = app_handle.emit_to(
        window_label,
        DESKTOP_TASK_PROGRESS_EVENT,
        DesktopTaskProgressEvent {
            task_id: task_id.to_string(),
            progress,
            timestamp,
        },
    );
}

fn normalize_task_id(task_id: Option<&str>) -> Option<String> {
    task_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn remember_pending_cancel(cancel_state: &mut DesktopTaskCancelState, task_id: &str) {
    if task_id.trim().is_empty() || cancel_state.pending.contains(task_id) {
        return;
    }

    if cancel_state.pending.len() >= MAX_PENDING_CANCEL_IDS {
        if let Some(stale_task_id) = cancel_state.pending.iter().next().cloned() {
            cancel_state.pending.remove(&stale_task_id);
        }
    }

    cancel_state.pending.insert(task_id.to_string());
}

pub fn request_desktop_task_cancel(state: &DesktopTaskCancelMap, task_id: &str) {
    let Some(task_id) = normalize_task_id(Some(task_id)) else {
        return;
    };

    if let Ok(mut cancel_state) = state.0.lock() {
        if let Some(active_task) = cancel_state.active.get(task_id.as_str()) {
            active_task.cancel_flag.store(true, Ordering::SeqCst);
        } else {
            remember_pending_cancel(&mut cancel_state, task_id.as_str());
        }
    }
}

fn emit_progress_from_stderr_line(
    app_handle: &tauri::AppHandle,
    window_label: &str,
    task_id: Option<&str>,
    line: &str,
) -> bool {
    let Some(progress) = parse_structured_progress_line(line) else {
        return false;
    };

    emit_progress_event(app_handle, window_label, task_id, progress);
    true
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

        if emit_progress_from_stderr_line(
            &app_handle,
            &window_label,
            task_id.as_deref(),
            trimmed_line,
        ) {
            continue;
        }

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

fn join_cli_output_and_cleanup(
    stdout_worker: thread::JoinHandle<Result<String, String>>,
    stderr_worker: thread::JoinHandle<Result<Vec<String>, String>>,
    conversation_context_path: Option<&PathBuf>,
) -> Result<(String, String), String> {
    let stdout_result = join_worker(stdout_worker, "stdout");
    let stderr_result = join_worker(stderr_worker, "stderr").map(|lines| lines.join("\n"));

    cleanup_temporary_file(conversation_context_path);

    Ok((stdout_result?, stderr_result?))
}

fn terminate_child_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let taskkill_result = Command::new("taskkill")
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

fn parse_desktop_task_response(stdout: &str) -> Result<DesktopTaskRunResponse, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<DesktopTaskRunResponse>(trimmed_stdout).map_err(|error| {
        format!("Failed to parse the shared CLI JSON response: {error}. Output: {trimmed_stdout}")
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

fn parse_ralph_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!("Failed to parse the Ralph CLI JSON response: {error}. Output: {trimmed_stdout}")
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

fn execute_scheduler_command(request: SchedulerCommandRequest) -> Result<Value, String> {
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

    let output = crate::shared_cli::create_shared_cli_command(&cli_args)?
        .command
        .output()
        .map_err(|error| {
            format!(
                "Failed to launch the scheduler CLI. {} {error}",
                crate::shared_cli::cli_runtime_error_hint()
            )
        })?;
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "The scheduler CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_scheduler_command_response(&stdout_text)
}

fn execute_ralph_command(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: RalphCommandRequest,
    cancel_flag: Arc<AtomicBool>,
) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let payload_workspace_root = normalized_workspace_root.clone();
    let task_id = normalize_task_id(request.task_id.as_deref());
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "ralph".to_string(),
    ];
    let (arguments, payload_paths) =
        rewrite_ralph_payload_arguments(payload_workspace_root.as_str(), request.arguments)?;

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

    cli_command
        .command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cli_command
            .command
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    #[cfg(unix)]
    {
        cli_command.command.process_group(0);
    }

    let mut child = match cli_command.command.spawn() {
        Ok(child) => child,
        Err(error) => {
            cleanup_temporary_files(&payload_paths);
            return Err(format!(
                "Failed to launch the Ralph CLI. {} {error}",
                crate::shared_cli::cli_runtime_error_hint()
            ));
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            cleanup_temporary_files(&payload_paths);
            return Err("The Ralph CLI did not expose a stdout stream.".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            cleanup_temporary_files(&payload_paths);
            return Err("The Ralph CLI did not expose a stderr stream.".to_string());
        }
    };

    let stdout_worker = thread::spawn(move || read_stdout(stdout));
    let stderr_worker =
        thread::spawn(move || read_stderr(stderr, app_handle, window_label, task_id));

    let status = loop {
        match child
            .try_wait()
            .map_err(|error| format!("Failed to wait for the Ralph CLI to finish: {error}"))?
        {
            Some(status) => break status,
            None => {
                if cancel_flag.load(Ordering::SeqCst) {
                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

                    let (stdout_text, stderr_text) =
                        match join_cli_output_and_cleanup(stdout_worker, stderr_worker, None) {
                            Ok(output) => output,
                            Err(error) => {
                                cleanup_temporary_files(&payload_paths);
                                return Err(error);
                            }
                        };
                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);
                    cleanup_temporary_files(&payload_paths);

                    if failure_tail == "The shared CLI exited without additional diagnostics." {
                        return Err("The Ralph CLI command was cancelled.".to_string());
                    }

                    return Err(format!(
                        "The Ralph CLI command was cancelled. {}",
                        failure_tail
                    ));
                }

                thread::sleep(Duration::from_millis(DESKTOP_TASK_WAIT_POLL_MS));
            }
        }
    };
    let (stdout_text, stderr_text) =
        match join_cli_output_and_cleanup(stdout_worker, stderr_worker, None) {
            Ok(output) => output,
            Err(error) => {
                cleanup_temporary_files(&payload_paths);
                return Err(error);
            }
        };
    cleanup_temporary_files(&payload_paths);

    if !status.success() {
        return Err(format!(
            "The Ralph CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_ralph_command_response(&stdout_text)
}

fn execute_mcp_command(request: McpCommandRequest) -> Result<Value, String> {
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

    let output = crate::shared_cli::create_shared_cli_command(&cli_args)?
        .command
        .output()
        .map_err(|error| {
            format!(
                "Failed to launch the MCP CLI. {} {error}",
                crate::shared_cli::cli_runtime_error_hint()
            )
        })?;
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "The MCP CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_mcp_command_response(&stdout_text)
}

fn execute_instruction_command(request: InstructionCommandRequest) -> Result<Value, String> {
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

    let output = crate::shared_cli::create_shared_cli_command(&cli_args)?
        .command
        .output()
        .map_err(|error| {
            format!(
                "Failed to launch the instruction CLI. {} {error}",
                crate::shared_cli::cli_runtime_error_hint()
            )
        })?;
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "The instruction CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_instruction_command_response(&stdout_text)
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
        reasoning,
        conversation_context,
        image_paths,
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
    let normalized_reasoning = normalize_optional_string(reasoning.as_deref());
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
        reasoning: normalized_reasoning.as_deref(),
        conversation_context_file: conversation_context_path.as_deref(),
        image_paths: image_paths.as_deref().unwrap_or(&[]),
    });
    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;

    cli_command
        .command
        .env(
            "MACHDOCH_DESKTOP_HOST_ELEVATED",
            if crate::desktop_shell::current_process_has_administrator_rights() {
                "true"
            } else {
                "false"
            },
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cli_command
            .command
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    #[cfg(unix)]
    {
        cli_command.command.process_group(0);
    }

    let mut child = cli_command.command.spawn().map_err(|error| {
        cleanup_temporary_file(conversation_context_path.as_ref());

        format!(
            "Failed to launch the shared CLI. {} {error}",
            crate::shared_cli::cli_runtime_error_hint()
        )
    })?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            cleanup_temporary_file(conversation_context_path.as_ref());
            return Err(
                "The shared CLI did not expose a stdout stream for the desktop bridge.".to_string(),
            );
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child_process_tree(&mut child);
            let _ = child.wait();
            cleanup_temporary_file(conversation_context_path.as_ref());
            return Err(
                "The shared CLI did not expose a stderr stream for the desktop bridge.".to_string(),
            );
        }
    };
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
                    emit_progress_event(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        create_bridge_progress(
                            normalized_task,
                            normalized_mode.as_deref(),
                            "cancelled",
                            "Cancelled by user; stopping the task.",
                            true,
                        ),
                    );

                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

                    let (stdout_text, stderr_text) = join_cli_output_and_cleanup(
                        stdout_worker,
                        stderr_worker,
                        conversation_context_path.as_ref(),
                    )?;

                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);
                    return Err(format!("The task was cancelled. {}", failure_tail));
                }

                if started_at.elapsed() >= Duration::from_millis(DESKTOP_TASK_TIMEOUT_MS) {
                    emit_progress_event(
                        &progress_app_handle,
                        &progress_window_label,
                        progress_task_id.as_deref(),
                        create_bridge_progress(
                            normalized_task,
                            normalized_mode.as_deref(),
                            "cancelled",
                            "Execution exceeded the desktop safety timeout; stopping the task.",
                            false,
                        ),
                    );

                    terminate_child_process_tree(&mut child);
                    let _ = child.wait();

                    let (stdout_text, stderr_text) = join_cli_output_and_cleanup(
                        stdout_worker,
                        stderr_worker,
                        conversation_context_path.as_ref(),
                    )?;

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
    let (stdout_text, stderr_text) = join_cli_output_and_cleanup(
        stdout_worker,
        stderr_worker,
        conversation_context_path.as_ref(),
    )?;

    if !stdout_text.trim().is_empty() {
        if let Ok(response) = parse_desktop_task_response(&stdout_text) {
            return Ok(response);
        }
    }

    if !status.success() {
        return Err(format!(
            "The shared CLI could not complete the task. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    let response = parse_desktop_task_response(&stdout_text);

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

fn resolve_attached_path(
    grants: &AttachmentPathGrantMap,
    workspace_root: Option<&str>,
    path: &str,
) -> Result<PathBuf, String> {
    let normalized_path = path.trim();

    if normalized_path.is_empty() {
        return Err("Expected an attached file path to open.".to_string());
    }

    let candidate_path = PathBuf::from(normalized_path);

    if !candidate_path.is_absolute() {
        return Err("Expected an absolute attached file path.".to_string());
    }

    let resolved_path = candidate_path
        .canonicalize()
        .map_err(|error| format!("Unable to resolve attached path `{normalized_path}`: {error}"))?;
    let resolved_metadata = fs::metadata(&resolved_path).map_err(|error| {
        format!(
            "Unable to inspect attached path `{}`: {error}",
            resolved_path.display()
        )
    })?;

    if !resolved_metadata.is_file() && !resolved_metadata.is_dir() {
        return Err("Expected the attached path to be a file or directory.".to_string());
    }

    if !attachment_path_is_granted(grants, &resolved_path)? {
        return Err(
            "Refused to open an attachment path that was not selected or created by this app session."
                .to_string(),
        );
    }

    if let Some(normalized_workspace_root) = workspace_root
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
    {
        let workspace_path = resolve_workspace_root_path(normalized_workspace_root)?;

        if resolved_path.starts_with(&workspace_path) {
            return Ok(resolved_path);
        }
    }

    if let Ok(clipboard_directory) = clipboard_image_attachment_directory().canonicalize() {
        if resolved_path.starts_with(&clipboard_directory) {
            return Ok(resolved_path);
        }
    }

    Err("Refused to open an attached path outside the active workspace or trusted temporary attachments.".to_string())
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
    request_desktop_task_cancel(&state, &task_id);
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
pub async fn get_active_desktop_tasks(
    state: tauri::State<'_, DesktopTaskCancelMap>,
) -> Result<Vec<ActiveDesktopTaskSummary>, String> {
    let cancel_state = state.0.lock().map_err(|_| {
        "Unable to inspect active desktop tasks because the task registry lock is unavailable."
            .to_string()
    })?;
    let mut tasks = cancel_state
        .active
        .iter()
        .map(|(id, task)| ActiveDesktopTaskSummary {
            id: id.clone(),
            kind: task.kind.clone(),
            workspace_root: task.workspace_root.clone(),
            arguments: task.arguments.clone(),
            started_at: task.started_at,
        })
        .collect::<Vec<_>>();

    tasks.sort_by(|left, right| left.id.cmp(&right.id));

    Ok(tasks)
}

#[tauri::command]
pub async fn run_desktop_task(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DesktopTaskCancelMap>,
    window: tauri::WebviewWindow,
    mut request: DesktopTaskRunRequest,
) -> Result<DesktopTaskRunResponse, String> {
    let window_label = window.label().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let task_id = normalize_task_id(request.task_id.as_deref());
    request.task_id = task_id.clone();

    if let Some(id) = &task_id {
        if let Ok(mut cancel_state) = state.0.lock() {
            if cancel_state.pending.remove(id) {
                cancel_flag.store(true, Ordering::SeqCst);
            }

            cancel_state.active.insert(
                id.clone(),
                ActiveDesktopTask {
                    cancel_flag: cancel_flag.clone(),
                    kind: "desktop".to_string(),
                    workspace_root: request.workspace_root.clone(),
                    arguments: Vec::new(),
                    started_at: create_progress_timestamp(),
                },
            );
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
pub async fn open_attached_path(
    state: tauri::State<'_, AttachmentPathGrantMap>,
    path: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    let resolved_path = resolve_attached_path(&state, workspace_root.as_deref(), &path)?;

    tauri::async_runtime::spawn_blocking(move || open_path_in_system_shell(&resolved_path))
        .await
        .map_err(|error| format!("The attachment opener stopped unexpectedly. {error}"))?
}

#[tauri::command]
pub async fn resolve_dropped_paths(
    state: tauri::State<'_, AttachmentPathGrantMap>,
    paths: Vec<String>,
) -> Result<DroppedPathsResolution, String> {
    let resolution =
        tauri::async_runtime::spawn_blocking(move || resolve_dropped_paths_sync(paths))
            .await
            .map_err(|error| format!("The dropped path resolver stopped unexpectedly. {error}"))?;

    remember_dropped_path_grants(&state, &resolution)?;

    Ok(resolution)
}

#[tauri::command]
pub async fn save_clipboard_image_attachment(
    state: tauri::State<'_, AttachmentPathGrantMap>,
    request: ClipboardImageAttachmentRequest,
) -> Result<String, String> {
    let path =
        tauri::async_runtime::spawn_blocking(move || save_clipboard_image_attachment_sync(request))
            .await
            .map_err(|error| {
                format!("The clipboard image saver stopped unexpectedly. {error}")
            })??;

    remember_attachment_path_grant(&state, &path)?;

    Ok(path)
}

#[tauri::command]
pub async fn run_scheduler_command(request: SchedulerCommandRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || execute_scheduler_command(request))
        .await
        .map_err(|error| format!("The scheduler command bridge stopped unexpectedly. {error}"))?
}

#[tauri::command]
pub async fn run_ralph_command(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DesktopTaskCancelMap>,
    window: tauri::WebviewWindow,
    mut request: RalphCommandRequest,
) -> Result<Value, String> {
    let window_label = window.label().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let task_id = normalize_task_id(request.task_id.as_deref());
    request.task_id = task_id.clone();

    if let Some(id) = &task_id {
        if let Ok(mut cancel_state) = state.0.lock() {
            if cancel_state.pending.remove(id) {
                cancel_flag.store(true, Ordering::SeqCst);
            }

            cancel_state.active.insert(
                id.clone(),
                ActiveDesktopTask {
                    cancel_flag: cancel_flag.clone(),
                    kind: "ralph".to_string(),
                    workspace_root: request.workspace_root.clone(),
                    arguments: request.arguments.clone(),
                    started_at: create_progress_timestamp(),
                },
            );
        }
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        execute_ralph_command(app_handle, window_label, request, cancel_flag)
    })
    .await
    .map_err(|error| format!("The Ralph command bridge stopped unexpectedly. {error}"));

    if let Some(id) = &task_id {
        if let Ok(mut cancel_state) = state.0.lock() {
            cancel_state.active.remove(id);
            cancel_state.pending.remove(id);
        }
    }

    result?
}

#[tauri::command]
pub async fn run_mcp_command(request: McpCommandRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || execute_mcp_command(request))
        .await
        .map_err(|error| format!("The MCP command bridge stopped unexpectedly. {error}"))?
}

#[tauri::command]
pub async fn run_instruction_command(request: InstructionCommandRequest) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || execute_instruction_command(request))
        .await
        .map_err(|error| format!("The instruction command bridge stopped unexpectedly. {error}"))?
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    use base64::Engine as _;
    use serde_json::json;

    use super::{
        build_cli_args, cleanup_temporary_file, format_command_failure,
        join_cli_output_and_cleanup, remember_attachment_path_grant, remember_pending_cancel,
        resolve_attached_path, save_clipboard_image_attachment_sync,
        write_conversation_context_file, AttachmentPathGrantMap, CliCommandOptions,
        ClipboardImageAttachmentRequest, DesktopTaskCancelState, MAX_PENDING_CANCEL_IDS,
    };

    fn create_test_directory(label: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "machdoch-desktop-task-test-{label}-{}-{timestamp}",
            std::process::id()
        ));

        fs::create_dir_all(&path).expect("test directory should be created");

        path
    }

    #[test]
    fn desktop_cli_args_force_one_shot_json_execution() {
        let args = build_cli_args(CliCommandOptions {
            workspace_root: "C:/workspace",
            task: "How is the weather?",
            mode: Some("ask"),
            profile: None,
            provider: Some("openai"),
            model: Some("gpt-5.2"),
            reasoning: Some("high"),
            conversation_context_file: None,
            image_paths: &[],
        });

        assert_eq!(args[0], "--quick");
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"--task".to_string()));
        assert!(args.contains(&"How is the weather?".to_string()));
        assert!(args.contains(&"--reasoning".to_string()));
        assert!(args.contains(&"high".to_string()));
    }

    #[test]
    fn desktop_cli_args_forward_image_paths() {
        let image_paths = vec![
            "C:/workspace/screenshot.png".to_string(),
            "C:/workspace/mockup.webp".to_string(),
        ];
        let args = build_cli_args(CliCommandOptions {
            workspace_root: "C:/workspace",
            task: "Describe the images",
            mode: None,
            profile: None,
            provider: Some("openai"),
            model: Some("gpt-5.5"),
            reasoning: None,
            conversation_context_file: None,
            image_paths: &image_paths,
        });

        assert_eq!(
            args.windows(2)
                .filter(|pair| pair[0] == "--image")
                .map(|pair| pair[1].clone())
                .collect::<Vec<_>>(),
            image_paths,
        );
    }

    #[test]
    fn command_failure_diagnostics_strip_node_debugger_noise() {
        let message = format_command_failure(
            "Debugger attached.\nmachdoch: Ralph flow `ralph-flow` is invalid.\nWaiting for the debugger to disconnect...\n",
            "",
        );

        assert_eq!(message, "machdoch: Ralph flow `ralph-flow` is invalid.");
    }

    #[test]
    fn desktop_context_temp_files_are_unique_for_parallel_tasks() {
        let context = json!({ "history": [] });
        let first_path = write_conversation_context_file(&context)
            .expect("first context file should be created");
        let second_path = write_conversation_context_file(&context)
            .expect("second context file should be created");

        assert_ne!(first_path, second_path);

        cleanup_temporary_file(Some(&first_path));
        cleanup_temporary_file(Some(&second_path));
    }

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
    }

    #[test]
    fn clipboard_image_attachment_rejects_oversized_payloads() {
        let data_base64 =
            base64::engine::general_purpose::STANDARD.encode(vec![0_u8; (20 * 1024 * 1024) + 1]);

        let result = save_clipboard_image_attachment_sync(ClipboardImageAttachmentRequest {
            data_base64,
            media_type: "image/png".to_string(),
            file_name: Some("huge.png".to_string()),
        });

        assert!(result
            .expect_err("oversized clipboard images should be rejected")
            .contains("too large"));
    }

    #[test]
    fn attached_path_resolver_allows_paths_inside_active_workspace() {
        let grants = AttachmentPathGrantMap::default();
        let workspace_path = create_test_directory("workspace");
        let file_path = workspace_path.join("plan.md");

        fs::write(&file_path, "plan").expect("test file should be written");
        remember_attachment_path_grant(&grants, file_path.to_string_lossy().as_ref())
            .expect("test file should be granted");

        let resolved_path = resolve_attached_path(
            &grants,
            Some(workspace_path.to_string_lossy().as_ref()),
            file_path.to_string_lossy().as_ref(),
        )
        .expect("workspace attachment should resolve");

        assert_eq!(
            resolved_path,
            file_path
                .canonicalize()
                .expect("test file should canonicalize")
        );

        let _ = fs::remove_dir_all(workspace_path);
    }

    #[test]
    fn attached_path_resolver_rejects_paths_outside_active_workspace() {
        let grants = AttachmentPathGrantMap::default();
        let workspace_path = create_test_directory("workspace");
        let outside_path = create_test_directory("outside");
        let file_path = outside_path.join("secret.txt");

        fs::write(&file_path, "secret").expect("test file should be written");
        remember_attachment_path_grant(&grants, file_path.to_string_lossy().as_ref())
            .expect("test file should be granted");

        let error = resolve_attached_path(
            &grants,
            Some(workspace_path.to_string_lossy().as_ref()),
            file_path.to_string_lossy().as_ref(),
        )
        .expect_err("outside attachment should be rejected");

        assert!(error.contains("outside the active workspace"));

        let _ = fs::remove_dir_all(workspace_path);
        let _ = fs::remove_dir_all(outside_path);
    }

    #[test]
    fn attached_path_resolver_rejects_ungranted_workspace_attachments() {
        let grants = AttachmentPathGrantMap::default();
        let workspace_path = create_test_directory("workspace");
        let file_path = workspace_path.join("forged.md");

        fs::write(&file_path, "forged").expect("test file should be written");

        let error = resolve_attached_path(
            &grants,
            Some(workspace_path.to_string_lossy().as_ref()),
            file_path.to_string_lossy().as_ref(),
        )
        .expect_err("ungranted attachment should be rejected");

        assert!(error.contains("not selected or created"));

        let _ = fs::remove_dir_all(workspace_path);
    }

    #[test]
    fn attached_path_resolver_allows_granted_clipboard_image_attachments() {
        let grants = AttachmentPathGrantMap::default();
        let saved_path = save_clipboard_image_attachment_sync(ClipboardImageAttachmentRequest {
            data_base64: base64::engine::general_purpose::STANDARD.encode([0_u8, 1_u8, 2_u8]),
            media_type: "image/png".to_string(),
            file_name: Some("clipboard.png".to_string()),
        })
        .expect("clipboard image attachment should be saved");
        remember_attachment_path_grant(&grants, &saved_path)
            .expect("clipboard image attachment should be granted");

        let resolved_path = resolve_attached_path(&grants, None, &saved_path)
            .expect("saved clipboard image attachment should resolve");

        assert_eq!(
            resolved_path,
            PathBuf::from(&saved_path)
                .canonicalize()
                .expect("saved clipboard image should canonicalize")
        );

        let _ = fs::remove_file(saved_path);
    }

    #[test]
    fn pending_cancel_ids_are_bounded() {
        let mut cancel_state = DesktopTaskCancelState::default();

        for index in 0..(MAX_PENDING_CANCEL_IDS + 10) {
            remember_pending_cancel(&mut cancel_state, &format!("task-{index}"));
        }

        assert_eq!(cancel_state.pending.len(), MAX_PENDING_CANCEL_IDS);
    }
}
