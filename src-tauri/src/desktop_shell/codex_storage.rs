use std::{
    env,
    fs::{self, File},
    io::{Read as _, Take},
    path::{Path, PathBuf},
};

use serde::Serialize;

const CODEX_SESSION_EXTENSION: &str = "jsonl";
const MAX_ATTRIBUTION_SCAN_BYTES: u64 = 2 * 1024 * 1024;
const MACHDOCH_PROMPT_MARKER: &[u8] = b"delegated Codex agent for Machdoch";
const CODEX_EXEC_ORIGINATOR_MARKER: &[u8] = b"codex_exec";

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachdochCodexSessionUsage {
    pub(crate) files: usize,
    pub(crate) bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MachdochCodexSessionCleanupResult {
    pub(crate) deleted_files: usize,
    pub(crate) deleted_bytes: u64,
    pub(crate) failed_files: usize,
    pub(crate) remaining_files: usize,
    pub(crate) remaining_bytes: u64,
}

fn codex_sessions_root() -> Option<PathBuf> {
    let codex_home = env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("USERPROFILE")
                .or_else(|| env::var_os("HOME"))
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".codex"))
        })?;

    Some(codex_home.join("sessions"))
}

fn find_codex_session_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut directories = vec![root.to_path_buf()];
    let mut files = Vec::new();

    while let Some(directory) = directories.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("Failed to read `{}`: {error}", directory.display()))?;

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();

            if file_type.is_dir() {
                directories.push(path);
            } else if file_type.is_file()
                && path.extension().and_then(|value| value.to_str())
                    == Some(CODEX_SESSION_EXTENSION)
            {
                files.push(path);
            }
        }
    }

    Ok(files)
}

fn contains_marker(contents: &[u8], marker: &[u8]) -> bool {
    contents
        .windows(marker.len())
        .any(|candidate| candidate == marker)
}

fn is_machdoch_codex_session(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut contents = Vec::new();
    let mut reader: Take<File> = file.take(MAX_ATTRIBUTION_SCAN_BYTES);

    if reader.read_to_end(&mut contents).is_err() {
        return false;
    }

    contains_marker(&contents, MACHDOCH_PROMPT_MARKER)
        && contains_marker(&contents, CODEX_EXEC_ORIGINATOR_MARKER)
}

fn attributed_session_files() -> Result<Vec<(PathBuf, u64)>, String> {
    let Some(root) = codex_sessions_root() else {
        return Ok(Vec::new());
    };

    Ok(find_codex_session_files(&root)?
        .into_iter()
        .filter(|path| is_machdoch_codex_session(path))
        .filter_map(|path| {
            let bytes = path.metadata().ok()?.len();
            Some((path, bytes))
        })
        .collect())
}

pub(crate) fn get_usage() -> Result<MachdochCodexSessionUsage, String> {
    let files = attributed_session_files()?;

    Ok(MachdochCodexSessionUsage {
        files: files.len(),
        bytes: files.iter().map(|(_, bytes)| bytes).sum(),
    })
}

pub(crate) fn clear() -> Result<MachdochCodexSessionCleanupResult, String> {
    let mut result = MachdochCodexSessionCleanupResult::default();

    for (path, bytes) in attributed_session_files()? {
        match fs::remove_file(path) {
            Ok(()) => {
                result.deleted_files += 1;
                result.deleted_bytes += bytes;
            }
            Err(_) => result.failed_files += 1,
        }
    }

    let remaining = get_usage()?;
    result.remaining_files = remaining.files;
    result.remaining_bytes = remaining.bytes;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{contains_marker, CODEX_EXEC_ORIGINATOR_MARKER, MACHDOCH_PROMPT_MARKER};

    #[test]
    fn attribution_requires_both_machdoch_prompt_and_codex_originator() {
        let attributed = b"originator: codex_exec; delegated Codex agent for Machdoch";
        let unrelated = b"originator: codex_exec; unrelated prompt";

        assert!(contains_marker(attributed, CODEX_EXEC_ORIGINATOR_MARKER));
        assert!(contains_marker(attributed, MACHDOCH_PROMPT_MARKER));
        assert!(!contains_marker(unrelated, MACHDOCH_PROMPT_MARKER));
    }
}
