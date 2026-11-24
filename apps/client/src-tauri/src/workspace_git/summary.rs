use std::path::Path;

use serde::Serialize;

use super::{canonical_workspace_root, enclosing_repository, fsmonitor, status};

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitSummary {
    pub(super) branch: String,
    pub(super) detached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
    pub(super) changes: usize,
    pub(super) conflicts: usize,
}

fn summary_from(repository_status: &status::RepositoryStatus) -> WorkspaceGitSummary {
    let branch = &repository_status.branch;
    WorkspaceGitSummary {
        branch: branch.display_name(),
        detached: branch.head.is_none(),
        upstream: branch.upstream.clone(),
        ahead: branch.ahead,
        behind: branch.behind,
        changes: repository_status.entries.len(),
        conflicts: repository_status
            .entries
            .iter()
            .filter(|entry| entry.conflicted)
            .count(),
    }
}

pub(super) fn read_summary(
    repository: &Path,
    fsmonitor: bool,
) -> Result<WorkspaceGitSummary, String> {
    status::repository_status(repository, status::UntrackedFiles::Normal, fsmonitor)
        .map(|repository_status| summary_from(&repository_status))
}

pub(super) fn load_summary(workspace_root: &str) -> Result<Option<WorkspaceGitSummary>, String> {
    let workspace = canonical_workspace_root(workspace_root)?;
    let Some(repository) = enclosing_repository(&workspace) else {
        return Ok(None);
    };
    crate::workspace_watch::ensure_watching(&workspace);
    read_summary(&repository, fsmonitor::enabled_for(&workspace)).map(Some)
}

#[cfg(test)]
mod tests {
    use std::{env, fs, time::SystemTime};

    use super::*;
    use crate::workspace_git::run_required;

    #[test]
    fn summarizes_branch_tracking_and_change_counts() {
        let summary = summary_from(&status::parse_status_v2(
            "# branch.oid abc\0# branch.head feature/x\0# branch.upstream origin/feature/x\0# branch.ab +2 -3\01 .M N... 100644 100644 100644 a b src/a.ts\02 R. N... 100644 100644 100644 a b R100 new.ts\0old.ts\0u UU N... 1 2 3 4 a b c conflict.ts\0? notes.md\0",
        ));
        assert_eq!(summary.branch, "feature/x");
        assert_eq!(summary.upstream.as_deref(), Some("origin/feature/x"));
        assert_eq!((summary.ahead, summary.behind), (2, 3));
        assert_eq!((summary.changes, summary.conflicts), (4, 1));

        let detached = summary_from(&status::parse_status_v2(
            "# branch.oid abc\0# branch.head (detached)\0",
        ));
        assert!(detached.detached);
        assert_eq!(detached.changes, 0);
    }

    #[test]
    fn reports_none_outside_repositories() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-workspace-git-summary-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("the directory should be created");
        assert_eq!(load_summary(&root.display().to_string()), Ok(None));
        run_required("git", &["init", "-b", "main"], &root).expect("git init should succeed");
        fs::write(root.join("new.txt"), "new\n").expect("the file should write");
        let summary = load_summary(&root.display().to_string())
            .expect("the summary should load")
            .expect("the repository should have a summary");
        assert_eq!(summary.branch, "main");
        assert_eq!(summary.changes, 1);
        let _ = fs::remove_dir_all(root);
    }
}
