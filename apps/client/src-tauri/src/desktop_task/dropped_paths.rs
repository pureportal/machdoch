use std::{collections::HashSet, fs, path::PathBuf};

use super::{paths::format_path_for_ui, DroppedPathEntry, DroppedPathsResolution};

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

fn dropped_path_dedupe_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.to_lowercase()
    }

    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

pub(super) fn resolve_dropped_paths_sync(paths: Vec<String>) -> DroppedPathsResolution {
    let mut seen_paths = HashSet::new();
    let mut entries = Vec::new();

    for path in paths {
        let Some(entry) = classify_dropped_path(&path) else {
            continue;
        };
        let dedupe_key = dropped_path_dedupe_key(&entry.path);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn dropped_path_case_variants() -> (String, String) {
        let path = std::env::temp_dir().join("machdoch-dropped-path-dedupe-test");
        let raw_path = path.display().to_string();

        (raw_path.clone(), raw_path.to_ascii_uppercase())
    }

    #[cfg(windows)]
    #[test]
    fn dropped_paths_ignore_empty_values_and_dedupe_case_insensitively_on_windows() {
        let (raw_path, uppercase_path) = dropped_path_case_variants();
        let resolution =
            resolve_dropped_paths_sync(vec!["   ".to_string(), raw_path.clone(), uppercase_path]);

        assert_eq!(resolution.entries.len(), 1);
    }

    #[cfg(not(windows))]
    #[test]
    fn dropped_paths_ignore_empty_values_and_preserve_case_distinct_paths_on_unix() {
        let (raw_path, uppercase_path) = dropped_path_case_variants();
        let resolution = resolve_dropped_paths_sync(vec![
            "   ".to_string(),
            raw_path.clone(),
            uppercase_path.clone(),
        ]);

        assert_eq!(resolution.entries.len(), 2);
        assert_eq!(resolution.entries[0].path, raw_path);
        assert_eq!(resolution.entries[1].path, uppercase_path);
    }
}
