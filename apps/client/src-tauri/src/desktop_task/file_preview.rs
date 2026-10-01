use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use serde::Deserialize;

use super::{
    attachment_paths::resolve_attached_path, is_binary_file_preview,
    local_file_links::resolve_local_path, paths::resolve_workspace_relative_path,
    process::open_path_in_system_shell, AttachmentPathGrantMap, BINARY_PREVIEW_SCAN_BYTES,
};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum FilePreviewTarget {
    Local {
        path: String,
    },
    Workspace {
        workspace_root: String,
        relative_path: String,
    },
    Attachment {
        path: String,
        workspace_root: Option<String>,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FilePreviewMode {
    Image,
    Pdf,
    Text,
}

fn resolve_file_preview_target(
    grants: &AttachmentPathGrantMap,
    target: FilePreviewTarget,
) -> Result<PathBuf, String> {
    match target {
        FilePreviewTarget::Local { path } => resolve_local_path(&path),
        FilePreviewTarget::Workspace {
            workspace_root,
            relative_path,
        } => resolve_workspace_relative_path(&workspace_root, &relative_path),
        FilePreviewTarget::Attachment {
            path,
            workspace_root,
        } => resolve_attached_path(grants, workspace_root.as_deref(), &path),
    }
}

fn can_preview_file(path: &Path, mode: Option<FilePreviewMode>) -> Result<bool, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to inspect `{}`: {error}", path.display()))?;

    if metadata.is_dir() {
        return Ok(false);
    }
    if !metadata.is_file() {
        return Err("Expected a file or folder to open.".to_string());
    }
    match mode {
        None => Ok(false),
        Some(FilePreviewMode::Image | FilePreviewMode::Pdf) => Ok(true),
        Some(FilePreviewMode::Text) => {
            let file = fs::File::open(path)
                .map_err(|error| format!("Unable to open `{}`: {error}", path.display()))?;
            let mut bytes = Vec::new();
            file.take(BINARY_PREVIEW_SCAN_BYTES as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| format!("Unable to read `{}`: {error}", path.display()))?;
            Ok(!is_binary_file_preview(&bytes))
        }
    }
}

#[tauri::command]
pub async fn prepare_file_preview(
    state: tauri::State<'_, AttachmentPathGrantMap>,
    target: FilePreviewTarget,
    mode: Option<FilePreviewMode>,
) -> Result<bool, String> {
    let path = resolve_file_preview_target(&state, target)?;
    tauri::async_runtime::spawn_blocking(move || {
        let can_preview = can_preview_file(&path, mode)?;
        if !can_preview {
            open_path_in_system_shell(&path)?;
        }
        Ok(can_preview)
    })
    .await
    .map_err(|error| format!("The file opener stopped unexpectedly. {error}"))?
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::*;

    struct PreviewFixture(PathBuf);

    impl PreviewFixture {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "machdoch-preview-routing-{}-{timestamp}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for PreviewFixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn folders_always_open_externally_even_with_supported_extensions() {
        let fixture = PreviewFixture::new();
        let folder = fixture.0.join("Logo.png");
        fs::create_dir(&folder).unwrap();
        for mode in [
            None,
            Some(FilePreviewMode::Text),
            Some(FilePreviewMode::Image),
            Some(FilePreviewMode::Pdf),
        ] {
            assert!(!can_preview_file(&folder, mode).unwrap());
        }
    }

    #[test]
    fn unsupported_files_and_binary_text_open_externally() {
        let fixture = PreviewFixture::new();
        let file = fixture.0.join("archive.zip");
        fs::write(&file, "unsupported file").unwrap();
        assert!(!can_preview_file(&file, None).unwrap());
        fs::write(&file, b"binary\0content").unwrap();
        assert!(!can_preview_file(&file, Some(FilePreviewMode::Text)).unwrap());
    }

    #[test]
    fn supported_files_remain_previewable_and_missing_paths_remain_errors() {
        let fixture = PreviewFixture::new();
        let file = fixture.0.join("Report.txt");
        fs::write(&file, "Preview 🦊").unwrap();
        assert!(can_preview_file(&file, Some(FilePreviewMode::Text)).unwrap());
        fs::write(&file, []).unwrap();
        assert!(can_preview_file(&file, Some(FilePreviewMode::Text)).unwrap());
        fs::write(&file, b"image\0bytes").unwrap();
        assert!(can_preview_file(&file, Some(FilePreviewMode::Image)).unwrap());
        assert!(can_preview_file(&file, Some(FilePreviewMode::Pdf)).unwrap());
        assert!(can_preview_file(&fixture.0.join("missing"), None).is_err());
    }

    #[test]
    fn targets_resolve_local_workspace_and_attached_folders_without_losing_path_checks() {
        let fixture = PreviewFixture::new();
        let workspace = fixture.0.join("workspace");
        let folder = workspace.join("PurePortal Logo Variants");
        let outside = fixture.0.join("outside");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&folder).unwrap();
        fs::create_dir(&outside).unwrap();
        let grants = AttachmentPathGrantMap::default();

        for target in [
            json!({"kind": "local", "path": folder}),
            json!({"kind": "workspace", "workspaceRoot": workspace, "relativePath": "PurePortal Logo Variants"}),
            json!({"kind": "attachment", "workspaceRoot": workspace, "path": folder}),
        ] {
            let target = serde_json::from_value(target).unwrap();
            assert_eq!(
                resolve_file_preview_target(&grants, target).unwrap(),
                folder.canonicalize().unwrap()
            );
        }

        for target in [
            json!({"kind": "local", "path": "relative/folder"}),
            json!({"kind": "workspace", "workspaceRoot": workspace, "relativePath": "../outside"}),
            json!({"kind": "attachment", "workspaceRoot": workspace, "path": outside}),
        ] {
            let target = serde_json::from_value(target).unwrap();
            assert!(resolve_file_preview_target(&grants, target).is_err());
        }
    }
}
