use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::Path,
};

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use url::form_urlencoded;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkspaceTool {
    Files,
    Terminal,
}

impl WorkspaceTool {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "files" => Ok(Self::Files),
            "terminal" => Ok(Self::Terminal),
            _ => Err(format!("Unknown workspace tool `{value}`.")),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Files => "files",
            Self::Terminal => "terminal",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Files => "Files",
            Self::Terminal => "Terminal",
        }
    }
}

fn window_label(tool: WorkspaceTool, workspace_root: &str) -> String {
    let mut hasher = DefaultHasher::new();
    workspace_root.hash(&mut hasher);
    format!("workspace-tool-{}-{:016x}", tool.id(), hasher.finish())
}

fn window_url(tool: WorkspaceTool, workspace_root: &str) -> String {
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("tool", tool.id())
        .append_pair("workspace", workspace_root)
        .finish();
    format!("index.html?{query}")
}

fn window_title(tool: WorkspaceTool, workspace_root: &str) -> String {
    let name = Path::new(workspace_root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(workspace_root);
    format!("{} · {name}", tool.title())
}

fn open_tool_window<R: Runtime>(
    app: &AppHandle<R>,
    tool: WorkspaceTool,
    workspace_root: &str,
) -> Result<(), String> {
    let label = window_label(tool, workspace_root);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        return window.set_focus().map_err(|error| error.to_string());
    }
    WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(window_url(tool, workspace_root).into()),
    )
    .title(window_title(tool, workspace_root))
    .inner_size(1100.0, 760.0)
    .min_inner_size(480.0, 320.0)
    .build()
    .map(|_| ())
    .map_err(|error| format!("The {} window could not be opened: {error}", tool.id()))
}

#[tauri::command]
pub async fn open_workspace_tool_window(
    app: AppHandle,
    workspace_root: String,
    tool: String,
) -> Result<(), String> {
    let tool = WorkspaceTool::parse(&tool)?;
    if !Path::new(&workspace_root).is_dir() {
        return Err("The workspace folder no longer exists.".to_string());
    }
    open_tool_window(&app, tool, &workspace_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_stable_window_per_tool_and_workspace() {
        assert_eq!(WorkspaceTool::parse("files"), Ok(WorkspaceTool::Files));
        assert!(WorkspaceTool::parse("git").is_err());
        let terminal = window_label(WorkspaceTool::Terminal, "C:\\work\\app");
        assert_eq!(
            terminal,
            window_label(WorkspaceTool::Terminal, "C:\\work\\app")
        );
        assert_ne!(
            terminal,
            window_label(WorkspaceTool::Files, "C:\\work\\app")
        );
        assert!(terminal
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-'));
        assert_eq!(
            window_url(WorkspaceTool::Files, "C:\\work\\my app"),
            "index.html?tool=files&workspace=C%3A%5Cwork%5Cmy+app"
        );
        assert_eq!(
            window_title(WorkspaceTool::Terminal, "/home/me/app"),
            "Terminal · app"
        );
    }
}
