use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock, PoisonError},
};

use super::{
    command_output_bounded, fsmonitor, output_error, repository_context, status, worktree_status,
    WorkspaceGitDiff, WorkspaceGitDiffRequest, WorkspaceGitPatch, MAX_GIT_DIFF_BYTES,
};

const MAX_CACHED_DIFFS: usize = 64;

type DiffKey = (PathBuf, String);
type DiffCache = HashMap<DiffKey, ((u64, u64), WorkspaceGitDiff)>;

static DIFF_CACHE: OnceLock<Mutex<DiffCache>> = OnceLock::new();

fn diff_cache() -> MutexGuard<'static, DiffCache> {
    DIFF_CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
pub(super) fn clear() {
    diff_cache().clear();
}

pub(super) fn truncate_diff_output(bytes: &[u8]) -> (String, bool) {
    let truncated = bytes.len() > MAX_GIT_DIFF_BYTES;
    let bounded = &bytes[..bytes.len().min(MAX_GIT_DIFF_BYTES)];
    let content = String::from_utf8_lossy(bounded)
        .trim_end_matches(['\r', '\n'])
        .to_string();
    (content, truncated)
}

pub(super) fn run_diff(
    repository: &Path,
    kind: &str,
    arguments: &[&str],
    allow_difference_exit: bool,
) -> Result<WorkspaceGitPatch, String> {
    let output = command_output_bounded("git", arguments, repository, MAX_GIT_DIFF_BYTES + 1)?;
    if !output.status.success() && !(allow_difference_exit && output.status.code() == Some(1)) {
        return Err(output_error("git", arguments, &output));
    }
    let (content, truncated) = truncate_diff_output(&output.stdout);
    let binary = content.contains("Binary files ") || content.contains("GIT binary patch");
    Ok(WorkspaceGitPatch {
        kind: kind.to_string(),
        content,
        binary,
        truncated,
    })
}

fn cache_key(repository: &Path) -> Option<(u64, u64)> {
    Some((
        crate::workspace_watch::worktree_generation(repository)?,
        status::repository_signature(repository, None)?,
    ))
}

fn known_entry(
    repository: &Path,
    relative_path: &str,
    fsmonitor: bool,
) -> Option<status::StatusEntry> {
    let find = |known: &status::RepositoryStatus| {
        known
            .entries
            .iter()
            .find(|entry| entry.path == relative_path)
            .cloned()
    };
    status::known_status(repository, status::UntrackedFiles::All, fsmonitor)
        .and_then(|known| find(&known))
        .or_else(|| {
            status::repository_status(repository, status::UntrackedFiles::Normal, fsmonitor)
                .ok()
                .and_then(|known| find(&known))
        })
}

fn changed_entry(
    repository: &Path,
    relative_path: &str,
    fsmonitor: bool,
) -> Result<status::StatusEntry, String> {
    if let Some(entry) = known_entry(repository, relative_path, fsmonitor) {
        return Ok(entry);
    }
    let selected = status::read_status_v2(
        repository,
        status::UntrackedFiles::All,
        fsmonitor,
        &[relative_path],
    )?;
    let entry = selected
        .entries
        .into_iter()
        .find(|entry| entry.path == relative_path)
        .ok_or_else(|| "This file is no longer changed.".to_string())?;
    if entry.code[0] != b'A' {
        return Ok(entry);
    }
    let renamed = status::repository_status(repository, status::UntrackedFiles::Normal, fsmonitor)?
        .entries
        .iter()
        .find(|candidate| candidate.path == relative_path && candidate.original_path.is_some())
        .cloned();
    Ok(renamed.unwrap_or(entry))
}

fn in_process_patch(
    kind: &str,
    path: &str,
    before: &[u8],
    after: &[u8],
) -> Option<WorkspaceGitPatch> {
    let content = worktree_status::unified_patch(path, before, after)?;
    Some(WorkspaceGitPatch {
        kind: kind.to_string(),
        content,
        binary: false,
        truncated: false,
    })
}

fn in_process_diff(repository: &Path, entry: &status::StatusEntry) -> Option<WorkspaceGitDiff> {
    if entry.untracked || entry.conflicted || entry.original_path.is_some() {
        return None;
    }
    let versions = worktree_status::file_versions(repository, &entry.path, entry.staged())?;
    let mut patches = Vec::new();
    if entry.staged() {
        let head = versions.head.as_deref()?;
        patches.push(in_process_patch(
            "staged",
            &entry.path,
            head,
            &versions.index,
        )?);
    }
    if entry.unstaged() {
        let worktree = versions.worktree.as_deref()?;
        patches.push(in_process_patch(
            "unstaged",
            &entry.path,
            &versions.index,
            worktree,
        )?);
    }
    Some(WorkspaceGitDiff {
        path: entry.path.clone(),
        original_path: None,
        patches,
    })
}

fn read_diff(repository: &Path, entry: status::StatusEntry) -> Result<WorkspaceGitDiff, String> {
    if let Some(diff) = in_process_diff(repository, &entry) {
        return Ok(diff);
    }
    let mut patches = Vec::new();
    let common = [
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--unified=3",
    ];
    let mut pathspec = vec!["--", entry.path.as_str()];
    if let Some(original) = entry.original_path.as_deref() {
        pathspec.push(original);
    }
    if entry.staged() {
        let mut arguments = vec!["diff", "--cached"];
        arguments.extend(common);
        arguments.extend(&pathspec);
        patches.push(run_diff(repository, "staged", &arguments, false)?);
    }
    if entry.unstaged() || entry.conflicted {
        let mut arguments = vec!["diff"];
        arguments.extend(common);
        arguments.extend(&pathspec[..2]);
        patches.push(run_diff(repository, "unstaged", &arguments, false)?);
    }
    if entry.untracked {
        patches.push(run_diff(
            repository,
            "untracked",
            &[
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--unified=3",
                "--",
                "/dev/null",
                &entry.path,
            ],
            true,
        )?);
    }
    Ok(WorkspaceGitDiff {
        path: entry.path,
        original_path: entry.original_path,
        patches,
    })
}

pub(super) fn load_diff(request: WorkspaceGitDiffRequest) -> Result<WorkspaceGitDiff, String> {
    let (workspace, repository) =
        repository_context(&request.workspace_root, &request.repository_root)?;
    if request.relative_path.is_empty() || request.relative_path.contains('\0') {
        return Err("Select a changed file to view its diff.".to_string());
    }
    crate::workspace_watch::ensure_watching(&workspace);
    let key = (repository.clone(), request.relative_path.clone());
    let state = cache_key(&repository);
    if let Some(state) = state {
        if let Some((cached_state, diff)) = diff_cache().get(&key) {
            if *cached_state == state {
                return Ok(diff.clone());
            }
        }
    }
    let fsmonitor = fsmonitor::enabled_for(&workspace);
    let entry = changed_entry(&repository, &request.relative_path, fsmonitor)?;
    let diff = read_diff(&repository, entry)?;
    if let Some(state) = state {
        let mut cache = diff_cache();
        if cache.len() >= MAX_CACHED_DIFFS {
            cache.retain(|_, (cached_state, _)| *cached_state == state);
            if cache.len() >= MAX_CACHED_DIFFS {
                cache.clear();
            }
        }
        cache.insert(key, (state, diff.clone()));
    }
    Ok(diff)
}
