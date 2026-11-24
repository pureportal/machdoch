use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{
    branch_alignment, canonical_workspace_root, config, current_operation, discover_repositories,
    fsmonitor, overview, parallel_map, refs, status, WorkspaceGitChange, WorkspaceGitRepository,
};

const MAX_REPOSITORY_STATUS_CHANGES: usize = 100;
const MAX_REPOSITORY_STATUS_WORKERS: usize = 6;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitRepositoriesStatusRequest {
    workspace_root: String,
    refresh: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRepositoryStatus {
    repository_root: String,
    relative_path: String,
    branch: String,
    detached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
    upstream_gone: bool,
    ahead: u64,
    behind: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_branch: Option<String>,
    staged_count: usize,
    unstaged_count: usize,
    untracked_count: usize,
    conflicted_count: usize,
    total_changes: usize,
    changes: Vec<WorkspaceGitChange>,
    changes_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_fetched_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRepositoriesStatus {
    workspace_root: String,
    repositories: Vec<WorkspaceGitRepositoryStatus>,
    scan_limited: bool,
    issues: Vec<String>,
}

fn inspect_repository(
    repository: &WorkspaceGitRepository,
    fsmonitor: bool,
) -> WorkspaceGitRepositoryStatus {
    let path = PathBuf::from(&repository.repository_root);
    let mut result = WorkspaceGitRepositoryStatus {
        repository_root: repository.repository_root.clone(),
        relative_path: repository.relative_path.clone(),
        ..WorkspaceGitRepositoryStatus::default()
    };
    let repository_status =
        match status::repository_status(&path, status::UntrackedFiles::Normal, fsmonitor) {
            Ok(repository_status) => repository_status,
            Err(error) => {
                result.error = Some(error);
                return result;
            }
        };
    let branch = &repository_status.branch;
    let current = branch.head.as_deref();
    let counts = repository_status.counts();
    let (changes, changes_truncated) = repository_status.changes(MAX_REPOSITORY_STATUS_CHANGES);
    result.default_branch =
        branch_alignment::default_branch(&refs::trunk_references(&path), current);
    result.parent_branch = current.and_then(|name| {
        config::read_repository_config(&path)
            .parents
            .get(name)
            .cloned()
    });
    result.branch = branch.display_name();
    result.detached = current.is_none();
    result.upstream = branch.upstream.clone();
    result.upstream_gone = branch.upstream_gone;
    result.ahead = branch.ahead;
    result.behind = branch.behind;
    result.staged_count = counts.staged;
    result.unstaged_count = counts.unstaged;
    result.untracked_count = counts.untracked;
    result.conflicted_count = counts.conflicted;
    result.total_changes = counts.total;
    result.changes = changes;
    result.changes_truncated = changes_truncated;
    result.operation = current_operation(&path);
    result.last_fetched_at = overview::last_fetched_at(&path);
    result
}

pub(super) fn load_repositories_status(
    request: WorkspaceGitRepositoriesStatusRequest,
) -> Result<WorkspaceGitRepositoriesStatus, String> {
    let workspace = canonical_workspace_root(&request.workspace_root)?;
    let discovery = discover_repositories(&request.workspace_root, request.refresh == Some(true))?;
    crate::workspace_watch::ensure_watching(&workspace);
    let fsmonitor = fsmonitor::enabled_for(&workspace);
    Ok(WorkspaceGitRepositoriesStatus {
        repositories: parallel_map(
            &discovery.repositories,
            MAX_REPOSITORY_STATUS_WORKERS,
            |repository| inspect_repository(repository, fsmonitor),
        ),
        workspace_root: discovery.workspace_root,
        scan_limited: discovery.scan_limited,
        issues: discovery.issues,
    })
}

#[cfg(test)]
mod tests {
    use std::{env, fs, time::SystemTime};

    use super::*;
    use crate::workspace_git::run_required;

    #[test]
    fn reports_every_repository_with_branches_and_changes() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-workspace-git-repositories-{}-{unique}",
            std::process::id()
        ));
        let nested = root.join("packages").join("nested");
        fs::create_dir_all(&nested).expect("the directories should be created");
        for (repository, branch) in [(&root, "main"), (&nested, "main")] {
            run_required("git", &["init", "-b", branch], repository).expect("git init");
            run_required(
                "git",
                &["config", "user.email", "test@example.com"],
                repository,
            )
            .expect("git config");
            run_required("git", &["config", "user.name", "Test"], repository).expect("git config");
            fs::write(repository.join("base.txt"), "base\n").expect("write");
            fs::write(repository.join(".gitignore"), "packages/\n").expect("write");
            run_required("git", &["add", "base.txt", ".gitignore"], repository).expect("git add");
            run_required("git", &["commit", "-m", "Base"], repository).expect("git commit");
        }
        run_required("git", &["switch", "-c", "feature"], &nested).expect("feature");
        run_required(
            "git",
            &["config", "branch.feature.machdoch-parent", "main"],
            &nested,
        )
        .expect("parent");
        run_required("git", &["switch", "-c", "feature-child"], &nested).expect("child");
        run_required(
            "git",
            &["config", "branch.feature-child.machdoch-parent", "feature"],
            &nested,
        )
        .expect("parent");
        fs::write(nested.join("new.txt"), "new\n").expect("write");

        let status = load_repositories_status(WorkspaceGitRepositoriesStatusRequest {
            workspace_root: root.display().to_string(),
            refresh: Some(true),
        })
        .expect("the status should load");
        assert_eq!(status.repositories.len(), 2);
        let top = &status.repositories[0];
        assert_eq!(top.relative_path, ".");
        assert_eq!(top.branch, "main");
        assert_eq!(top.default_branch.as_deref(), Some("main"));
        assert_eq!(top.total_changes, 0);
        let child = &status.repositories[1];
        assert_eq!(child.relative_path, "packages/nested");
        assert_eq!(child.branch, "feature-child");
        assert_eq!(child.parent_branch.as_deref(), Some("feature"));
        assert_eq!(child.default_branch.as_deref(), Some("main"));
        assert_eq!((child.untracked_count, child.total_changes), (1, 1));
        assert_eq!(child.changes[0].path, "new.txt");
        let _ = fs::remove_dir_all(root);
    }
}
