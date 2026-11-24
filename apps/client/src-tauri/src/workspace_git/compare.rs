use std::thread;

use serde::{Deserialize, Serialize};

use super::{
    actions::resolve_revision,
    history::{changed_files, WorkspaceGitCommitFile},
    parse_commits, repository_context, run_optional, run_required, WorkspaceGitCommit,
};

const MAX_COMPARED_COMMITS: usize = 300;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitCompareRequest {
    workspace_root: String,
    repository_root: String,
    base: String,
    head: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitComparison {
    base: String,
    head: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    merge_base: Option<String>,
    ahead: u64,
    behind: u64,
    commits: Vec<WorkspaceGitCommit>,
    commits_truncated: bool,
    files: Vec<WorkspaceGitCommitFile>,
    files_truncated: bool,
}

fn parse_left_right(output: &str) -> (u64, u64) {
    let mut counts = output
        .split_whitespace()
        .map(|count| count.parse().unwrap_or_default());
    let behind = counts.next().unwrap_or_default();
    let ahead = counts.next().unwrap_or_default();
    (ahead, behind)
}

pub(super) fn load_comparison(
    request: WorkspaceGitCompareRequest,
) -> Result<WorkspaceGitComparison, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    let base = resolve_revision(Some(&request.base), &repository)?;
    let head = resolve_revision(Some(&request.head), &repository)?;
    let range = format!("{base}..{head}");
    let symmetric = format!("{base}...{head}");
    let (merge_base, counts, commits) = thread::scope(|scope| {
        let merge_base = scope.spawn(|| {
            run_optional("git", &["merge-base", &base, &head], &repository)
                .filter(|value| !value.is_empty())
        });
        let counts = scope.spawn(|| {
            run_required(
                "git",
                &["rev-list", "--left-right", "--count", &symmetric],
                &repository,
            )
        });
        let commits = run_required(
            "git",
            &[
                "log",
                &format!("-{}", MAX_COMPARED_COMMITS + 1),
                "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI",
                &range,
                "--",
            ],
            &repository,
        );
        (
            merge_base.join().ok().flatten(),
            counts
                .join()
                .unwrap_or_else(|_| Err("Git stopped unexpectedly.".to_string())),
            commits,
        )
    });
    let (ahead, behind) = parse_left_right(&counts?);
    let mut commits = parse_commits(&commits?);
    let commits_truncated = commits.len() > MAX_COMPARED_COMMITS;
    commits.truncate(MAX_COMPARED_COMMITS);
    let (files, files_truncated) =
        changed_files(&repository, merge_base.as_deref().unwrap_or(&base), &head)?;
    Ok(WorkspaceGitComparison {
        base,
        head,
        merge_base,
        ahead,
        behind,
        commits,
        commits_truncated,
        files,
        files_truncated,
    })
}

#[cfg(test)]
mod tests {
    use std::{env, fs, time::SystemTime};

    use super::*;
    use crate::workspace_git::test_repository;

    #[test]
    fn compares_branches_from_their_merge_base() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-git-compare-{}-{unique}",
            std::process::id()
        ));
        test_repository(&root);
        run_required("git", &["switch", "--quiet", "-c", "feature"], &root).expect("switch");
        fs::write(root.join("feature.txt"), "feature\n").expect("write");
        run_required("git", &["add", "feature.txt"], &root).expect("add");
        run_required("git", &["commit", "--quiet", "-m", "feature"], &root).expect("commit");
        run_required("git", &["switch", "--quiet", "main"], &root).expect("switch");
        fs::write(root.join("main.txt"), "main\n").expect("write");
        run_required("git", &["add", "main.txt"], &root).expect("add");
        run_required("git", &["commit", "--quiet", "-m", "main"], &root).expect("commit");
        let workspace_root = root.display().to_string();
        let comparison = load_comparison(WorkspaceGitCompareRequest {
            workspace_root: workspace_root.clone(),
            repository_root: workspace_root,
            base: "main".to_string(),
            head: "feature".to_string(),
        })
        .expect("the comparison should load");
        assert_eq!((comparison.ahead, comparison.behind), (1, 1));
        assert_eq!(comparison.commits.len(), 1);
        assert_eq!(comparison.commits[0].subject, "feature");
        assert_eq!(comparison.files.len(), 1);
        assert!(comparison.merge_base.is_some());
        let feature = run_required("git", &["rev-parse", "feature"], &root).expect("rev-parse");
        assert_eq!(comparison.head, feature.trim());
        assert!(crate::workspace_git::history::validate_commit(&comparison.base).is_ok());
        let _ = fs::remove_dir_all(root);
    }
}
