use std::{
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;

use crate::runtime_snapshot::resolve_workspace_root_path;

const DESKTOP_TASK_PROGRESS_EVENT: &str = "desktop-task-progress";

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTaskProgressEvent {
    task_id: String,
    line: String,
    timestamp: u64,
}

fn get_repo_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Unable to resolve the desktop shell repository root.".to_string())
}

fn get_cli_entry_path(repo_root: &Path) -> Result<PathBuf, String> {
    let cli_entry_path = repo_root.join("src").join("cli").join("main.ts");

    if cli_entry_path.exists() {
        return Ok(cli_entry_path);
    }

    Err(format!(
        "Unable to locate the shared CLI entry at {}.",
        cli_entry_path.display()
    ))
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

fn build_cli_command(
    repo_root: &Path,
    cli_entry_path: &Path,
    workspace_root: &str,
    task: &str,
    mode: Option<&str>,
    provider: Option<&str>,
    model: Option<&str>,
    conversation_context_file: Option<&Path>,
) -> Command {
    let mut command = Command::new("node");

    command
        .current_dir(repo_root)
        .arg("--import")
        .arg("tsx")
        .arg(cli_entry_path)
        .arg("--json")
        .arg("--verbose")
        .arg("--cwd")
        .arg(workspace_root)
        .arg("--task")
        .arg(task);

    if let Some(mode) = mode {
        command.arg("--mode").arg(mode);
    }

    if let Some(provider) = provider {
        command.arg("--runtime-provider").arg(provider);
    }

    if let Some(model) = model {
        command.arg("--model").arg(model);
    }

    if let Some(conversation_context_file) = conversation_context_file {
        command
            .arg("--conversation-context-file")
            .arg(conversation_context_file);
    }

    command
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
        let line = line.map_err(|error| {
            format!("Failed to read the shared CLI stderr stream: {error}")
        })?;

        let trimmed_line = line.trim();

        if trimmed_line.is_empty() {
            continue;
        }

        emit_progress_line(
            &app_handle,
            &window_label,
            task_id.as_deref(),
            trimmed_line,
        );
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

fn execute_desktop_task(
    app_handle: tauri::AppHandle,
    window_label: String,
    workspace_root: String,
    task: String,
    mode: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    conversation_context: Option<Value>,
    task_id: Option<String>,
) -> Result<DesktopTaskRunResponse, String> {
    let workspace_path = resolve_workspace_root_path(&workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();

    let normalized_task = task.trim();

    if normalized_task.is_empty() {
        return Err("Expected a non-empty task before running the desktop executor.".to_string());
    }

    let repo_root = get_repo_root()?;
    let cli_entry_path = get_cli_entry_path(&repo_root)?;
    let normalized_provider = provider.and_then(|value| {
        let trimmed = value.trim().to_string();

        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let normalized_mode = mode.and_then(|value| {
        let trimmed = value.trim().to_string();

        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let normalized_model = model.and_then(|value| {
        let trimmed = value.trim().to_string();

        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    let conversation_context_path = conversation_context
        .as_ref()
        .map(write_conversation_context_file)
        .transpose()?;

    let mut command = build_cli_command(
        &repo_root,
        &cli_entry_path,
        &normalized_workspace_root,
        normalized_task,
        normalized_mode.as_deref(),
        normalized_provider.as_deref(),
        normalized_model.as_deref(),
        conversation_context_path.as_deref(),
    );

    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        cleanup_temporary_file(conversation_context_path.as_ref());

        format!(
            "Failed to launch the shared CLI through Node.js. Ensure Node.js >= 20.10 is installed and available on PATH. {error}"
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

    let stdout_worker = thread::spawn(move || read_stdout(stdout));
    let stderr_worker = thread::spawn(move || {
        read_stderr(stderr, app_handle, window_label, task_id)
    });

    let status = child
        .wait()
        .map_err(|error| format!("Failed to wait for the shared CLI to finish: {error}"))?;
    let stdout_text = join_worker(stdout_worker, "stdout")?;
    let stderr_text = join_worker(stderr_worker, "stderr")?.join("\n");

    if !status.success() {
        cleanup_temporary_file(conversation_context_path.as_ref());
        return Err(format!(
            "The shared CLI could not complete the task. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    let trimmed_stdout = stdout_text.trim();

    let response = serde_json::from_str::<DesktopTaskRunResponse>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the shared CLI JSON response: {error}. Output: {trimmed_stdout}"
        )
    });

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
            format!(
                "Unable to resolve `{normalized_relative_path}` inside the workspace: {error}"
            )
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
pub async fn run_desktop_task(
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
    workspace_root: String,
    task: String,
    mode: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    conversation_context: Option<Value>,
    task_id: Option<String>,
) -> Result<DesktopTaskRunResponse, String> {
    let window_label = window.label().to_string();

    tauri::async_runtime::spawn_blocking(move || {
        execute_desktop_task(
            app_handle,
            window_label,
            workspace_root,
            task,
            mode,
            provider,
            model,
            conversation_context,
            task_id,
        )
    })
    .await
    .map_err(|error| format!("The desktop task bridge stopped unexpectedly. {error}"))?
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
