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

pub(super) fn format_path_for_ui(path: &Path) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

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
