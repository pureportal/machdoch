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

pub(crate) fn format_path_for_ui(path: &Path) -> String {
    format_path_string_for_ui(&path.display().to_string())
}

pub(super) fn resolve_workspace_path(
    workspace_root: &str,
    requested_path: &str,
) -> Result<PathBuf, String> {
    let normalized_path = requested_path.trim();

    if normalized_path.is_empty() {
        return Err("Expected a path to open.".to_string());
    }

    resolve_workspace_root_path(workspace_root)?
        .join(normalized_path)
        .canonicalize()
        .map_err(|error| format!("Unable to find `{normalized_path}`: {error}"))
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
    fn workspace_paths_resolve_files_outside_the_workspace() {
        let fixture = std::env::temp_dir().join(format!(
            "machdoch-workspace-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let workspace = fixture.join("workspace");
        let outside = fixture.join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let file = outside.join("Logo.png");
        std::fs::write(&file, "image").unwrap();
        let root = workspace.to_string_lossy();
        let expected = file.canonicalize().unwrap();

        for requested in ["../outside/Logo.png", file.to_str().unwrap()] {
            assert_eq!(resolve_workspace_path(&root, requested).unwrap(), expected);
        }
        assert!(resolve_workspace_path(&root, "   ").is_err());
        assert!(resolve_workspace_path(&root, "../outside/missing.png").is_err());
        std::fs::remove_dir_all(fixture).unwrap();
    }
}
