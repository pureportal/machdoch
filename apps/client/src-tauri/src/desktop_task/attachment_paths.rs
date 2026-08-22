use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::runtime_snapshot::resolve_workspace_root_path;

use super::{
    attachments::{attachment_path_is_granted, clipboard_image_attachment_directory},
    AttachmentPathGrantMap,
};

pub(super) fn resolve_attached_path(
    grants: &AttachmentPathGrantMap,
    workspace_root: Option<&str>,
    path: &str,
) -> Result<PathBuf, String> {
    let normalized_path = normalize_attached_path_input(path)?;
    let resolved_path = canonicalize_attached_path(normalized_path)?;

    if is_clipboard_image_attachment(&resolved_path) {
        return Ok(resolved_path);
    }

    if is_inside_workspace(workspace_root, &resolved_path)? {
        return Ok(resolved_path);
    }

    if !attachment_path_is_granted(grants, &resolved_path)? {
        return Err(
            "Refused to open an attachment path that was not selected or created by this app session."
                .to_string(),
        );
    }

    Err("Refused to open an attached path outside the active workspace or trusted temporary attachments.".to_string())
}

fn normalize_attached_path_input(path: &str) -> Result<&str, String> {
    let normalized_path = path.trim();

    if normalized_path.is_empty() {
        return Err("Expected an attached file path to open.".to_string());
    }

    Ok(normalized_path)
}

fn canonicalize_attached_path(normalized_path: &str) -> Result<PathBuf, String> {
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

    Ok(resolved_path)
}

fn is_clipboard_image_attachment(resolved_path: &Path) -> bool {
    clipboard_image_attachment_directory()
        .canonicalize()
        .is_ok_and(|clipboard_directory| resolved_path.starts_with(clipboard_directory))
}

fn is_inside_workspace(workspace_root: Option<&str>, resolved_path: &Path) -> Result<bool, String> {
    let Some(normalized_workspace_root) = workspace_root
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
    else {
        return Ok(false);
    };

    let workspace_path = resolve_workspace_root_path(normalized_workspace_root)?;

    Ok(resolved_path.starts_with(workspace_path))
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
