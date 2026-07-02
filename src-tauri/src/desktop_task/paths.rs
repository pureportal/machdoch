use std::path::{Path, PathBuf};

use crate::runtime_snapshot::resolve_workspace_root_path;

fn is_windows_drive_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();

    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

fn strip_windows_namespace_prefix(path: &str) -> Option<&str> {
    let bytes = path.as_bytes();

    if bytes.len() >= 4
        && bytes[0] == b'\\'
        && bytes[1] == b'\\'
        && matches!(bytes[2], b'?' | b'.')
        && bytes[3] == b'\\'
    {
        Some(&path[4..])
    } else {
        None
    }
}

fn strip_windows_unc_prefix(path: &str) -> Option<&str> {
    let bytes = path.as_bytes();

    if bytes.len() >= 4
        && bytes[0].eq_ignore_ascii_case(&b'U')
        && bytes[1].eq_ignore_ascii_case(&b'N')
        && bytes[2].eq_ignore_ascii_case(&b'C')
        && bytes[3] == b'\\'
    {
        Some(&path[4..])
    } else {
        None
    }
}

fn format_path_string_for_ui(path: &str) -> String {
    let Some(path_without_namespace_prefix) = strip_windows_namespace_prefix(path) else {
        return path.to_string();
    };

    if let Some(unc_path) = strip_windows_unc_prefix(path_without_namespace_prefix) {
        return format!(r"\\{}", unc_path);
    }

    if is_windows_drive_absolute_path(path_without_namespace_prefix) {
        return path_without_namespace_prefix.to_string();
    }

    path.to_string()
}

pub(super) fn format_path_for_ui(path: &Path) -> String {
    format_path_string_for_ui(&path.display().to_string())
}

pub(super) fn resolve_workspace_relative_path(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_formatter_strips_windows_extended_length_prefixes() {
        assert_eq!(
            format_path_string_for_ui(r"\\?\C:\Users\me\screen.png"),
            r"C:\Users\me\screen.png"
        );
        assert_eq!(
            format_path_string_for_ui(r"\\?\UNC\server\share\screen.png"),
            r"\\server\share\screen.png"
        );
        assert_eq!(
            format_path_string_for_ui(r"\\?\unc\server\share\screen.png"),
            r"\\server\share\screen.png"
        );
        assert_eq!(
            format_path_string_for_ui(r"\\.\C:\Users\me\screen.png"),
            r"C:\Users\me\screen.png"
        );
        assert_eq!(
            format_path_string_for_ui(r"\\.\UNC\server\share\screen.png"),
            r"\\server\share\screen.png"
        );
        assert_eq!(
            format_path_string_for_ui(r"C:\Users\me\screen.png"),
            r"C:\Users\me\screen.png"
        );
        assert_eq!(
            format_path_string_for_ui(r"\\?\Volume{abc}\screen.png"),
            r"\\?\Volume{abc}\screen.png"
        );
        assert_eq!(
            format_path_string_for_ui(r"\\.\pipe\machdoch-agent"),
            r"\\.\pipe\machdoch-agent"
        );
    }

    #[test]
    fn relative_workspace_paths_reject_absolute_input() {
        let absolute_path = std::env::temp_dir().join("absolute.txt");
        let error = resolve_workspace_relative_path(
            std::env::temp_dir().to_string_lossy().as_ref(),
            absolute_path.to_string_lossy().as_ref(),
        )
        .expect_err("absolute relative path input should be rejected");

        assert!(error.contains("not an absolute path"));
    }
}
