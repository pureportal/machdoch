use std::{path::Path, thread};

use serde::{Deserialize, Serialize};

use super::{
    branch_alignment, command_output, current_operation, discover_repositories, output_error,
    parallel_map, parse_status, parse_upstream_track, stack, WorkspaceGitChange,
    WorkspaceGitRepository,
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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRepositoriesStatus {
    workspace_root: String,
    repositories: Vec<WorkspaceGitRepositoryStatus>,
    scan_limited: bool,
    issues: Vec<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct BranchHeader {
    branch: String,
    detached: bool,
    upstream: Option<String>,
    upstream_gone: bool,
    ahead: u64,
    behind: u64,
}

fn parse_branch_header(header: &str) -> BranchHeader {
    let header = header.strip_prefix("## ").unwrap_or(header);
    if header == "HEAD (no branch)" {
        return BranchHeader {
            branch: "Detached HEAD".to_string(),
            detached: true,
            ..BranchHeader::default()
        };
    }
    for prefix in ["No commits yet on ", "Initial commit on "] {
        if let Some(branch) = header.strip_prefix(prefix) {
            return BranchHeader {
                branch: branch.to_string(),
                ..BranchHeader::default()
            };
        }
    }
    let (names, track) = match header.split_once(" [") {
        Some((names, track)) => (names, track.trim_end_matches(']')),
        None => (header, ""),
    };
    let (branch, upstream) = match names.split_once("...") {
        Some((branch, upstream)) => (branch, Some(upstream.to_string())),
        None => (names, None),
    };
    let (ahead, behind, upstream_gone) = parse_upstream_track(track);
    BranchHeader {
        branch: branch.to_string(),
        detached: false,
        upstream,
        upstream_gone,
        ahead,
        behind,
    }
}

fn read_status_with_branch(repository: &Path) -> Result<String, String> {
    let arguments = [
        "status",
        "--porcelain=v1",
        "--branch",
        "-z",
        "--untracked-files=all",
    ];
    let output = command_output("git", &arguments, repository)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(output_error("git", &arguments, &output))
    }
}

fn inspect_repository(repository: &WorkspaceGitRepository) -> WorkspaceGitRepositoryStatus {
    let path = Path::new(&repository.repository_root);
    let mut status = WorkspaceGitRepositoryStatus {
        repository_root: repository.repository_root.clone(),
        relative_path: repository.relative_path.clone(),
        ..WorkspaceGitRepositoryStatus::default()
    };
    let operation = current_operation(path);
    let (status_output, trunk_references, parents) = thread::scope(|scope| {
        let status_worker = scope.spawn(|| read_status_with_branch(path));
        let trunk_worker = scope.spawn(|| branch_alignment::read_trunk_references(path));
        let parents = stack::read_parents(path);
        (
            status_worker
                .join()
                .unwrap_or_else(|_| Err("Git status stopped unexpectedly.".to_string())),
            trunk_worker.join().unwrap_or_default(),
            parents,
        )
    });
    let output = match status_output {
        Ok(output) => output,
        Err(error) => {
            status.error = Some(error);
            return status;
        }
    };
    let (header, entries) = match output.split_once('\0') {
        Some((header, entries)) if header.starts_with("## ") => (header, entries),
        _ => ("", output.as_str()),
    };
    let branch = parse_branch_header(header);
    let (changes, _, staged, unstaged, untracked, conflicted, total) = parse_status(entries);
    let current = (!branch.detached).then_some(branch.branch.as_str());
    status.default_branch = branch_alignment::default_branch(&trunk_references, current);
    status.parent_branch = current.and_then(|name| parents.get(name).cloned());
    status.branch = branch.branch;
    status.detached = branch.detached;
    status.upstream = branch.upstream;
    status.upstream_gone = branch.upstream_gone;
    status.ahead = branch.ahead;
    status.behind = branch.behind;
    status.staged_count = staged;
    status.unstaged_count = unstaged;
    status.untracked_count = untracked;
    status.conflicted_count = conflicted;
    status.total_changes = total;
    status.changes_truncated = total > MAX_REPOSITORY_STATUS_CHANGES;
    status.changes = changes
        .into_iter()
        .take(MAX_REPOSITORY_STATUS_CHANGES)
        .collect();
    status.operation = operation;
    status
}

pub(super) fn load_repositories_status(
    request: WorkspaceGitRepositoriesStatusRequest,
) -> Result<WorkspaceGitRepositoriesStatus, String> {
    let discovery = discover_repositories(&request.workspace_root, request.refresh == Some(true))?;
    Ok(WorkspaceGitRepositoriesStatus {
        repositories: parallel_map(
            &discovery.repositories,
            MAX_REPOSITORY_STATUS_WORKERS,
            inspect_repository,
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
    fn parses_branch_headers() {
        assert_eq!(
            parse_branch_header("## feature/x...origin/feature/x [ahead 2, behind 3]"),
            BranchHeader {
                branch: "feature/x".to_string(),
                detached: false,
                upstream: Some("origin/feature/x".to_string()),
                upstream_gone: false,
                ahead: 2,
                behind: 3,
            }
        );
        assert!(parse_branch_header("## main...origin/main [gone]").upstream_gone);
        assert_eq!(parse_branch_header("## main").upstream, None);
        assert!(parse_branch_header("## HEAD (no branch)").detached);
        assert_eq!(
            parse_branch_header("## No commits yet on trunk").branch,
            "trunk"
        );
    }

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
