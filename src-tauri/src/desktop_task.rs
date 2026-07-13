use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod attachment_paths;
mod attachments;
mod cli_commands;
mod commands;
mod diagnostics;
mod dropped_paths;
mod paths;
mod payload;
mod payload_files;
mod process;
mod progress;
mod ralph;
mod registry;

use attachment_paths::resolve_attached_path;
use attachments::{
    remember_attachment_path_grant, remember_dropped_path_grants,
    save_clipboard_image_attachment_sync,
};
use cli_commands::{
    execute_instruction_command, execute_mcp_command, execute_scheduler_command,
    execute_task_interview_command, start_scheduler_service as start_scheduler_service_process,
};
use commands::execute_desktop_task;
#[cfg(test)]
use diagnostics::format_timeout_duration;
use dropped_paths::resolve_dropped_paths_sync;
use paths::{format_path_for_ui, resolve_workspace_relative_path};
use process::open_path_in_system_shell;
use progress::{create_bridge_progress, create_progress_timestamp, emit_progress_event};
use ralph::{execute_ralph_command, resolve_ralph_flow_path_for_open};
use registry::{
    acknowledge_completed_task_results, active_task_ids, active_task_summaries,
    completed_desktop_task_result, finish_active_task, normalize_task_id,
    recent_completed_task_results, register_active_task, remember_completed_task_result,
    ActiveDesktopTaskRegistration,
};
pub use registry::{
    request_all_desktop_task_cancels, request_desktop_task_cancel, ActiveDesktopTaskSummary,
    DesktopTaskCancelMap, RecentDesktopTaskResult,
};

pub fn cleanup_stale_task_context_files() {
    payload::cleanup_stale_conversation_context_files();
}

const MAX_CONCURRENT_EXTERNAL_TASKS: usize = 2;

pub struct DesktopTaskLimiter {
    semaphore: Arc<Semaphore>,
    waiting: AtomicUsize,
}

impl Default for DesktopTaskLimiter {
    fn default() -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_EXTERNAL_TASKS)),
            waiting: AtomicUsize::new(0),
        }
    }
}

struct WaitingTaskGuard<'a>(&'a AtomicUsize);

impl Drop for WaitingTaskGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl DesktopTaskLimiter {
    fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
    }

    fn next_queue_position(&self) -> usize {
        self.waiting.load(Ordering::SeqCst) + 1
    }

    async fn acquire(&self, cancel_flag: &AtomicBool) -> Result<OwnedSemaphorePermit, String> {
        self.waiting.fetch_add(1, Ordering::SeqCst);
        let _waiting_guard = WaitingTaskGuard(&self.waiting);
        let acquire = self.semaphore.clone().acquire_owned();
        tokio::pin!(acquire);

        loop {
            tokio::select! {
                permit = &mut acquire => {
                    return permit.map_err(|_| "The desktop task executor is shutting down.".to_string());
                }
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    if cancel_flag.load(Ordering::SeqCst) {
                        return Err("The task was cancelled while waiting for an execution slot.".to_string());
                    }
                }
            }
        }
    }
}

const DESKTOP_TASK_TIMEOUT_MS: u64 = 20 * 60 * 1_000;
const DESKTOP_TASK_ABSOLUTE_TIMEOUT_MS: u64 = 60 * 60 * 1_000;
const RALPH_COMMAND_TIMEOUT_MS: u64 = 12 * 60 * 60 * 1_000;
const DESKTOP_TASK_WAIT_POLL_MS: u64 = 250;
const MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_ATTACHMENT_PATH_GRANTS: usize = 1024;
const MAX_FILE_PREVIEW_BYTES: u64 = 512 * 1024;
const BINARY_PREVIEW_SCAN_BYTES: usize = 8 * 1024;

#[derive(Default)]
pub struct AttachmentPathGrantMap(pub Mutex<HashSet<PathBuf>>);

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
    provider: Option<String>,
    model: Option<String>,
    reasoning: Option<String>,
    conversation_context: Option<Value>,
    image_paths: Option<Vec<String>>,
    task_id: Option<String>,
    session_id: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreviewReadResult {
    content: String,
    bytes_read: usize,
    max_bytes: u64,
    truncated: bool,
    lossy: bool,
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
pub struct OpenRalphFlowPathRequest {
    workspace_root: String,
    flow: String,
    scope: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInterviewCommandRequest {
    workspace_root: String,
    arguments: Vec<String>,
    task_id: Option<String>,
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
    active_task_ids(&state)
}

#[tauri::command]
pub async fn get_active_desktop_tasks(
    state: tauri::State<'_, DesktopTaskCancelMap>,
) -> Result<Vec<ActiveDesktopTaskSummary>, String> {
    active_task_summaries(&state)
}

#[tauri::command]
pub async fn get_recent_desktop_task_results(
    state: tauri::State<'_, DesktopTaskCancelMap>,
    task_ids: Vec<String>,
) -> Result<Vec<RecentDesktopTaskResult>, String> {
    recent_completed_task_results(&state, &task_ids)
}

#[tauri::command]
pub async fn acknowledge_recent_desktop_task_results(
    state: tauri::State<'_, DesktopTaskCancelMap>,
    task_ids: Vec<String>,
) -> Result<(), String> {
    acknowledge_completed_task_results(&state, &task_ids)
}

#[tauri::command]
pub async fn run_desktop_task(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DesktopTaskCancelMap>,
    limiter: tauri::State<'_, DesktopTaskLimiter>,
    window: tauri::WebviewWindow,
    mut request: DesktopTaskRunRequest,
) -> Result<DesktopTaskRunResponse, String> {
    let window_label = window.label().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let task_id = normalize_task_id(request.task_id.as_deref());
    let task_started_at = create_progress_timestamp();
    let task_workspace_root = request.workspace_root.clone();
    request.task_id = task_id.clone();

    if let Some(id) = &task_id {
        let claimed = register_active_task(
            &state,
            ActiveDesktopTaskRegistration {
                task_id: id.clone(),
                cancel_flag: cancel_flag.clone(),
                kind: "desktop".to_string(),
                workspace_root: request.workspace_root.clone(),
                arguments: Vec::new(),
                started_at: task_started_at,
                operation_key: request
                    .session_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|session_id| !session_id.is_empty())
                    .map(|session_id| format!("session:{session_id}")),
            },
        )?;

        if !claimed {
            if let Some(completed_result) = completed_desktop_task_result(&state, id)? {
                return completed_result;
            }

            return Err(format!("MACHDOCH_TASK_ALREADY_ACTIVE:{id}"));
        }
    }

    if limiter.available_permits() == 0 {
        emit_progress_event(
            &app_handle,
            &window_label,
            task_id.as_deref(),
            create_bridge_progress(
                request.task.trim(),
                request.mode.as_deref(),
                "starting",
                &format!(
                    "Waiting for an execution slot (queue position {}).",
                    limiter.next_queue_position()
                ),
                true,
            ),
        );
    }

    let execution_permit = match limiter.acquire(&cancel_flag).await {
        Ok(permit) => permit,
        Err(error) => {
            finish_active_task(&state, task_id.as_deref());
            return Err(error);
        }
    };

    let result = tauri::async_runtime::spawn_blocking(move || {
        let _execution_permit = execution_permit;
        execute_desktop_task(app_handle, window_label, request, cancel_flag)
    })
    .await
    .map_err(|error| format!("The desktop task bridge stopped unexpectedly. {error}"))
    .and_then(|task_result| task_result);

    if let Some(id) = &task_id {
        remember_completed_task_result(
            &state,
            RecentDesktopTaskResult::desktop(
                id.clone(),
                task_workspace_root,
                Vec::new(),
                task_started_at,
                create_progress_timestamp(),
                &result,
            ),
        );
    }

    finish_active_task(&state, task_id.as_deref());

    result
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

fn ensure_file_preview_path(path: PathBuf) -> Result<PathBuf, String> {
    let metadata = fs::metadata(&path).map_err(|error| {
        format!(
            "Unable to inspect preview path `{}`: {error}",
            path.display()
        )
    })?;

    if !metadata.is_file() {
        return Err("Expected the preview path to be a file.".to_string());
    }

    Ok(path)
}

fn read_file_preview_sync(path: PathBuf) -> Result<FilePreviewReadResult, String> {
    let preview_path = ensure_file_preview_path(path)?;
    let mut file = fs::File::open(&preview_path).map_err(|error| {
        format!(
            "Unable to open preview file `{}`: {error}",
            preview_path.display()
        )
    })?;
    let mut bytes = Vec::new();

    file.by_ref()
        .take(MAX_FILE_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            format!(
                "Unable to read preview file `{}`: {error}",
                preview_path.display()
            )
        })?;

    let truncated = bytes.len() as u64 > MAX_FILE_PREVIEW_BYTES;

    if truncated {
        bytes.truncate(MAX_FILE_PREVIEW_BYTES as usize);
    }

    if bytes
        .iter()
        .take(BINARY_PREVIEW_SCAN_BYTES)
        .any(|byte| *byte == 0)
    {
        return Err(
            "This file does not look like text. Use the external opener instead.".to_string(),
        );
    }

    let lossy = std::str::from_utf8(&bytes).is_err();
    let content = String::from_utf8_lossy(&bytes).into_owned();

    Ok(FilePreviewReadResult {
        content,
        bytes_read: bytes.len(),
        max_bytes: MAX_FILE_PREVIEW_BYTES,
        truncated,
        lossy,
    })
}

#[tauri::command]
pub async fn resolve_workspace_file_preview_path(
    workspace_root: String,
    relative_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved_path = resolve_workspace_relative_path(&workspace_root, &relative_path)?;
        let preview_path = ensure_file_preview_path(resolved_path)?;

        Ok(format_path_for_ui(&preview_path))
    })
    .await
    .map_err(|error| format!("The workspace preview resolver stopped unexpectedly. {error}"))?
}

#[tauri::command]
pub async fn read_workspace_file_preview(
    workspace_root: String,
    relative_path: String,
) -> Result<FilePreviewReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved_path = resolve_workspace_relative_path(&workspace_root, &relative_path)?;

        read_file_preview_sync(resolved_path)
    })
    .await
    .map_err(|error| format!("The workspace file preview reader stopped unexpectedly. {error}"))?
}

#[tauri::command]
pub async fn open_ralph_flow_in_explorer(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: OpenRalphFlowPathRequest,
) -> Result<(), String> {
    let window_label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let resolved_path = resolve_ralph_flow_path_for_open(app_handle, window_label, request)?;
        open_path_in_system_shell(&resolved_path)
    })
    .await
    .map_err(|error| format!("The Ralph flow opener stopped unexpectedly. {error}"))?
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
pub async fn resolve_attached_file_preview_path(
    state: tauri::State<'_, AttachmentPathGrantMap>,
    path: String,
    workspace_root: Option<String>,
) -> Result<String, String> {
    let resolved_path = resolve_attached_path(&state, workspace_root.as_deref(), &path)?;
    let preview_path = ensure_file_preview_path(resolved_path)?;

    Ok(format_path_for_ui(&preview_path))
}

#[tauri::command]
pub async fn read_attached_file_preview(
    state: tauri::State<'_, AttachmentPathGrantMap>,
    path: String,
    workspace_root: Option<String>,
) -> Result<FilePreviewReadResult, String> {
    let resolved_path = resolve_attached_path(&state, workspace_root.as_deref(), &path)?;

    tauri::async_runtime::spawn_blocking(move || read_file_preview_sync(resolved_path))
        .await
        .map_err(|error| {
            format!("The attachment file preview reader stopped unexpectedly. {error}")
        })?
}

#[tauri::command]
pub async fn resolve_attached_image_preview_path(
    state: tauri::State<'_, AttachmentPathGrantMap>,
    path: String,
    workspace_root: Option<String>,
) -> Result<String, String> {
    let resolved_path = resolve_attached_path(&state, workspace_root.as_deref(), &path)?;

    if !resolved_path.is_file() {
        return Err("Expected the attached image preview path to be a file.".to_string());
    }

    Ok(format_path_for_ui(&resolved_path))
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
pub async fn run_scheduler_command(
    limiter: tauri::State<'_, DesktopTaskLimiter>,
    request: SchedulerCommandRequest,
) -> Result<Value, String> {
    let cancel_flag = AtomicBool::new(false);
    let execution_permit = limiter.acquire(&cancel_flag).await?;

    tauri::async_runtime::spawn_blocking(move || {
        let _execution_permit = execution_permit;
        execute_scheduler_command(request)
    })
    .await
    .map_err(|error| format!("The scheduler command bridge stopped unexpectedly. {error}"))?
}

#[tauri::command]
pub async fn start_scheduler_service(request: SchedulerCommandRequest) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || start_scheduler_service_process(request))
        .await
        .map_err(|error| format!("The scheduler service launcher stopped unexpectedly. {error}"))?
}

#[tauri::command]
pub async fn run_ralph_command(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DesktopTaskCancelMap>,
    limiter: tauri::State<'_, DesktopTaskLimiter>,
    window: tauri::WebviewWindow,
    mut request: RalphCommandRequest,
) -> Result<Value, String> {
    let window_label = window.label().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let task_id = normalize_task_id(request.task_id.as_deref());
    request.task_id = task_id.clone();

    if let Some(id) = &task_id {
        let claimed = register_active_task(
            &state,
            ActiveDesktopTaskRegistration {
                task_id: id.clone(),
                cancel_flag: cancel_flag.clone(),
                kind: "ralph".to_string(),
                workspace_root: request.workspace_root.clone(),
                arguments: request.arguments.clone(),
                started_at: create_progress_timestamp(),
                operation_key: None,
            },
        )?;

        if !claimed {
            return Err(format!("MACHDOCH_TASK_ALREADY_ACTIVE:{id}"));
        }
    }

    let execution_permit = match limiter.acquire(&cancel_flag).await {
        Ok(permit) => permit,
        Err(error) => {
            finish_active_task(&state, task_id.as_deref());
            return Err(error);
        }
    };

    let result = tauri::async_runtime::spawn_blocking(move || {
        let _execution_permit = execution_permit;
        execute_ralph_command(app_handle, window_label, request, cancel_flag)
    })
    .await
    .map_err(|error| format!("The Ralph command bridge stopped unexpectedly. {error}"));

    finish_active_task(&state, task_id.as_deref());

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

#[tauri::command]
pub async fn run_task_interview_command(
    app_handle: tauri::AppHandle,
    limiter: tauri::State<'_, DesktopTaskLimiter>,
    window: tauri::WebviewWindow,
    request: TaskInterviewCommandRequest,
) -> Result<Value, String> {
    let window_label = window.label().to_string();
    let cancel_flag = AtomicBool::new(false);
    let execution_permit = limiter.acquire(&cancel_flag).await?;

    tauri::async_runtime::spawn_blocking(move || {
        let _execution_permit = execution_permit;
        execute_task_interview_command(app_handle, window_label, request)
    })
    .await
    .map_err(|error| format!("The task interview command bridge stopped unexpectedly. {error}"))?
}

#[cfg(test)]
mod tests {
    use super::{format_timeout_duration, DESKTOP_TASK_TIMEOUT_MS, RALPH_COMMAND_TIMEOUT_MS};

    #[test]
    fn ralph_command_timeout_allows_long_autonomous_runs() {
        assert!(RALPH_COMMAND_TIMEOUT_MS > DESKTOP_TASK_TIMEOUT_MS);
        assert_eq!(
            format_timeout_duration(RALPH_COMMAND_TIMEOUT_MS),
            "12 hours"
        );
        assert_eq!(
            format_timeout_duration(DESKTOP_TASK_TIMEOUT_MS),
            "20 minutes"
        );
    }
}
