use std::{
    collections::HashSet,
    path::PathBuf,
    sync::atomic::AtomicBool,
    sync::{Arc, Mutex},
};

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
    execute_task_interview_command,
};
use commands::execute_desktop_task;
#[cfg(test)]
use diagnostics::format_timeout_duration;
use dropped_paths::resolve_dropped_paths_sync;
use paths::{format_path_for_ui, resolve_workspace_relative_path};
use process::open_path_in_system_shell;
use progress::create_progress_timestamp;
use ralph::{execute_ralph_command, resolve_ralph_flow_path_for_open};
use registry::{
    active_task_ids, active_task_summaries, finish_active_task, normalize_task_id,
    recent_completed_task_results, register_active_task, remember_completed_task_result,
    ActiveDesktopTaskRegistration,
};
pub use registry::{
    request_desktop_task_cancel, ActiveDesktopTaskSummary, DesktopTaskCancelMap,
    RecentDesktopTaskResult,
};

const DESKTOP_TASK_TIMEOUT_MS: u64 = 20 * 60 * 1_000;
const RALPH_COMMAND_TIMEOUT_MS: u64 = 12 * 60 * 60 * 1_000;
const DESKTOP_TASK_WAIT_POLL_MS: u64 = 250;
const MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_ATTACHMENT_PATH_GRANTS: usize = 1024;

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
pub async fn run_desktop_task(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, DesktopTaskCancelMap>,
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
        register_active_task(
            &state,
            ActiveDesktopTaskRegistration {
                task_id: id.clone(),
                cancel_flag: cancel_flag.clone(),
                kind: "desktop".to_string(),
                workspace_root: request.workspace_root.clone(),
                arguments: Vec::new(),
                started_at: task_started_at,
            },
        );
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
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
        register_active_task(
            &state,
            ActiveDesktopTaskRegistration {
                task_id: id.clone(),
                cancel_flag: cancel_flag.clone(),
                kind: "ralph".to_string(),
                workspace_root: request.workspace_root.clone(),
                arguments: request.arguments.clone(),
                started_at: create_progress_timestamp(),
            },
        );
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
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
    window: tauri::WebviewWindow,
    request: TaskInterviewCommandRequest,
) -> Result<Value, String> {
    let window_label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || {
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
