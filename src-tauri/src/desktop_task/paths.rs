use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use crate::runtime_snapshot::resolve_workspace_root_path;

use super::{
    attachments::{attachment_path_is_granted, clipboard_image_attachment_directory},
    AttachmentPathGrantMap, DroppedPathEntry, DroppedPathsResolution,
};

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

pub(super) fn resolve_dropped_paths_sync(paths: Vec<String>) -> DroppedPathsResolution {
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

pub(super) fn resolve_attached_path(
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

    if let Ok(clipboard_directory) = clipboard_image_attachment_directory().canonicalize() {
        if resolved_path.starts_with(&clipboard_directory) {
            return Ok(resolved_path);
        }
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

    if !attachment_path_is_granted(grants, &resolved_path)? {
        return Err(
            "Refused to open an attachment path that was not selected or created by this app session."
                .to_string(),
        );
    }

    Err("Refused to open an attached path outside the active workspace or trusted temporary attachments.".to_string())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use base64::Engine as _;

    use super::super::{
        attachments::{remember_attachment_path_grant, save_clipboard_image_attachment_sync},
        ClipboardImageAttachmentRequest,
    };
    use super::*;

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
    fn dropped_paths_ignore_empty_values_and_dedupe() {
        let path = std::env::temp_dir().join("machdoch-dropped-path-dedupe-test");
        let raw_path = path.display().to_string();
        let resolution = resolve_dropped_paths_sync(vec![
            "   ".to_string(),
            raw_path.clone(),
            raw_path.to_ascii_uppercase(),
        ]);

        assert_eq!(resolution.entries.len(), 1);
    }

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
    fn attached_path_resolver_rejects_ungranted_paths_outside_active_workspace() {
        let grants = AttachmentPathGrantMap::default();
        let workspace_path = create_test_directory("workspace");
        let outside_path = create_test_directory("outside");
        let file_path = outside_path.join("secret.txt");

        fs::write(&file_path, "secret").expect("test file should be written");

        let error = resolve_attached_path(
            &grants,
            Some(workspace_path.to_string_lossy().as_ref()),
            file_path.to_string_lossy().as_ref(),
        )
        .expect_err("ungranted outside attachment should be rejected");

        assert!(error.contains("not selected or created by this app session"));

        let _ = fs::remove_dir_all(workspace_path);
        let _ = fs::remove_dir_all(outside_path);
    }

    #[test]
    fn attached_path_resolver_rejects_granted_directories_outside_active_workspace() {
        let grants = AttachmentPathGrantMap::default();
        let workspace_path = create_test_directory("workspace");
        let outside_directory = create_test_directory("outside-folder");

        remember_attachment_path_grant(&grants, outside_directory.to_string_lossy().as_ref())
            .expect("test directory should be granted");

        let error = resolve_attached_path(
            &grants,
            Some(workspace_path.to_string_lossy().as_ref()),
            outside_directory.to_string_lossy().as_ref(),
        )
        .expect_err("granted outside directory should be rejected");

        assert!(error.contains("outside the active workspace"));

        let _ = fs::remove_dir_all(workspace_path);
        let _ = fs::remove_dir_all(outside_directory);
    }

    #[test]
    fn attached_path_resolver_allows_workspace_attachments_after_restart() {
        let grants = AttachmentPathGrantMap::default();
        let workspace_path = create_test_directory("workspace");
        let file_path = workspace_path.join("persisted.md");

        fs::write(&file_path, "persisted").expect("test file should be written");

        let resolved_path = resolve_attached_path(
            &grants,
            Some(workspace_path.to_string_lossy().as_ref()),
            file_path.to_string_lossy().as_ref(),
        )
        .expect("persisted workspace attachment should resolve after restart");

        assert_eq!(
            resolved_path,
            file_path
                .canonicalize()
                .expect("test file should canonicalize")
        );

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
    fn attached_path_resolver_allows_clipboard_image_attachments_after_restart() {
        let grants = AttachmentPathGrantMap::default();
        let saved_path = save_clipboard_image_attachment_sync(ClipboardImageAttachmentRequest {
            data_base64: base64::engine::general_purpose::STANDARD.encode([0_u8, 1_u8, 2_u8]),
            media_type: "image/png".to_string(),
            file_name: Some("restart-clipboard.png".to_string()),
        })
        .expect("clipboard image attachment should be saved");

        let resolved_path = resolve_attached_path(&grants, None, &saved_path)
            .expect("saved clipboard image attachment should resolve without an in-memory grant");

        assert_eq!(
            resolved_path,
            PathBuf::from(&saved_path)
                .canonicalize()
                .expect("saved clipboard image should canonicalize")
        );

        let _ = fs::remove_file(saved_path);
    }
}
