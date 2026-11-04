use std::path::Path;

use serde::Serialize;

use super::{canonical_workspace_root, command_output, output_error};

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

fn parse_summary(output: &str) -> WorkspaceGitSummary {
    let mut summary = WorkspaceGitSummary::default();
    let mut records = output.split_terminator('\0');
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.head" if value == "(detached)" => {
                    summary.detached = true;
                    summary.branch = "Detached HEAD".to_string();
                }
                "branch.head" => summary.branch = value.to_string(),
                "branch.upstream" => summary.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split_whitespace() {
                        if let Some(count) = part.strip_prefix('+') {
                            summary.ahead = count.parse().unwrap_or_default();
                        } else if let Some(count) = part.strip_prefix('-') {
                            summary.behind = count.parse().unwrap_or_default();
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        match record.as_bytes().first() {
            Some(b'1' | b'?') => summary.changes += 1,
            Some(b'2') => {
                summary.changes += 1;
                records.next();
            }
            Some(b'u') => {
                summary.changes += 1;
                summary.conflicts += 1;
            }
            _ => {}
        }
    }
    summary
}

pub(super) fn read_summary(repository: &Path) -> Result<Option<WorkspaceGitSummary>, String> {
    let arguments = [
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
    ];
    let output = command_output("git", &arguments, repository)?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if detail.contains("not a git repository") {
            return Ok(None);
        }
        return Err(output_error("git", &arguments, &output));
    }
    Ok(Some(parse_summary(&String::from_utf8_lossy(
        &output.stdout,
    ))))
}

pub(super) fn load_summary(workspace_root: &str) -> Result<Option<WorkspaceGitSummary>, String> {
    read_summary(&canonical_workspace_root(workspace_root)?)
}

#[cfg(test)]
mod tests {
    use std::{env, fs, time::SystemTime};

    use super::*;
    use crate::workspace_git::run_required;

    #[test]
    fn parses_branch_tracking_and_change_counts() {
        let summary = parse_summary(
            "# branch.oid abc\0# branch.head feature/x\0# branch.upstream origin/feature/x\0# branch.ab +2 -3\01 .M N... 100644 100644 100644 a b src/a.ts\02 R. N... 100644 100644 100644 a b R100 new.ts\0old.ts\0u UU N... 1 2 3 4 a b c conflict.ts\0? notes.md\0",
        );
        assert_eq!(summary.branch, "feature/x");
        assert_eq!(summary.upstream.as_deref(), Some("origin/feature/x"));
        assert_eq!((summary.ahead, summary.behind), (2, 3));
        assert_eq!((summary.changes, summary.conflicts), (4, 1));

        let detached = parse_summary("# branch.oid abc\0# branch.head (detached)\0");
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
