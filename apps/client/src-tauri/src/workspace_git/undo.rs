use std::path::Path;

use serde::Serialize;

use super::{
    current_operation,
    history::{changed_files, WorkspaceGitCommitFile},
    repository_context, run_optional, run_required, WorkspaceGitRepositoryRequest,
};

const MAX_REFLOG_ENTRIES: usize = 400;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UndoKind {
    Commit,
    Amend,
    Checkout,
    Reset,
    Merge,
    Rebase,
    Pull,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitUndoPreview {
    kind: UndoKind,
    description: String,
    current_head: String,
    target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_branch: Option<String>,
    files: Vec<WorkspaceGitCommitFile>,
    files_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReflogEntry {
    hash: String,
    subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UndoPlan {
    kind: UndoKind,
    description: String,
    current_head: String,
    target: String,
    target_branch: Option<String>,
}

fn parse_reflog(output: &str) -> Vec<ReflogEntry> {
    output
        .lines()
        .filter_map(|line| {
            let (hash, subject) = line.split_once('\u{1f}')?;
            Some(ReflogEntry {
                hash: hash.trim().to_string(),
                subject: subject.trim().to_string(),
            })
        })
        .collect()
}

fn is_object_name(value: &str) -> bool {
    value.len() >= 7 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn rebase_start(entries: &[ReflogEntry]) -> Option<usize> {
    entries.iter().position(|entry| {
        (entry.subject.starts_with("rebase") || entry.subject.starts_with("pull --rebase"))
            && entry.subject.contains("(start)")
    })
}

fn plan_undo(entries: &[ReflogEntry]) -> Option<UndoPlan> {
    let latest = entries.first()?;
    let (action, detail) = latest
        .subject
        .split_once(':')
        .map(|(action, detail)| (action.trim(), detail.trim()))
        .unwrap_or((latest.subject.as_str(), ""));
    let previous = |index: usize| entries.get(index).map(|entry| entry.hash.clone());
    let (kind, target, target_branch) = if action.contains("(finish)") {
        let kind = if action.starts_with("pull") {
            UndoKind::Pull
        } else {
            UndoKind::Rebase
        };
        (kind, previous(rebase_start(entries)? + 1)?, None)
    } else if action == "commit (initial)" {
        return None;
    } else if action == "commit (amend)" {
        (UndoKind::Amend, previous(1)?, None)
    } else if action == "commit (merge)" || action.starts_with("merge") {
        (UndoKind::Merge, previous(1)?, None)
    } else if action == "commit" {
        (UndoKind::Commit, previous(1)?, None)
    } else if action == "checkout" {
        let from = detail
            .strip_prefix("moving from ")
            .and_then(|moving| moving.split_once(" to "))
            .map(|(from, _)| from.to_string())?;
        let branch = (!is_object_name(&from)).then_some(from);
        (UndoKind::Checkout, previous(1)?, branch)
    } else if action == "reset" {
        (UndoKind::Reset, previous(1)?, None)
    } else if action.starts_with("pull") {
        (UndoKind::Pull, previous(1)?, None)
    } else if action.starts_with("cherry-pick") {
        (UndoKind::CherryPick, previous(1)?, None)
    } else if action.starts_with("revert") {
        (UndoKind::Revert, previous(1)?, None)
    } else {
        return None;
    };
    Some(UndoPlan {
        kind,
        description: latest.subject.clone(),
        current_head: latest.hash.clone(),
        target,
        target_branch,
    })
}

fn current_plan(repository: &Path) -> Option<UndoPlan> {
    if current_operation(repository).is_some() {
        return None;
    }
    let output = run_optional(
        "git",
        &[
            "reflog",
            "show",
            &format!("-{MAX_REFLOG_ENTRIES}"),
            "--format=%H%x1f%gs",
            "HEAD",
            "--",
        ],
        repository,
    )?;
    plan_undo(&parse_reflog(&output))
}

pub(super) fn load_undo(
    request: WorkspaceGitRepositoryRequest,
) -> Result<Option<WorkspaceGitUndoPreview>, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    let Some(plan) = current_plan(&repository) else {
        return Ok(None);
    };
    let (files, files_truncated) = changed_files(&repository, &plan.target, &plan.current_head)?;
    Ok(Some(WorkspaceGitUndoPreview {
        kind: plan.kind,
        description: plan.description,
        current_head: plan.current_head,
        target: plan.target,
        target_branch: plan.target_branch,
        files,
        files_truncated,
    }))
}

pub(super) fn undo(repository: &Path, target: Option<&str>) -> Result<(), String> {
    let plan = current_plan(repository).ok_or_else(|| "There is nothing to undo.".to_string())?;
    if target.map(str::trim) != Some(plan.target.as_str()) {
        return Err("The history changed. Review the undo again.".to_string());
    }
    match (plan.kind, plan.target_branch.as_deref()) {
        (UndoKind::Checkout, Some(branch)) => {
            run_required("git", &["switch", "--", branch], repository)?;
        }
        (UndoKind::Checkout, None) => {
            run_required("git", &["switch", "--detach", &plan.target], repository)?;
        }
        (UndoKind::Commit | UndoKind::Amend, _) => {
            run_required(
                "git",
                &["reset", "--quiet", "--soft", &plan.target],
                repository,
            )?;
        }
        _ => {
            run_required(
                "git",
                &["reset", "--quiet", "--keep", &plan.target],
                repository,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(lines: &[(&str, &str)]) -> Vec<ReflogEntry> {
        lines
            .iter()
            .map(|(hash, subject)| ReflogEntry {
                hash: hash.to_string(),
                subject: subject.to_string(),
            })
            .collect()
    }

    #[test]
    fn plans_undo_for_each_reflog_operation() {
        let commit = plan_undo(&entries(&[
            ("c2", "commit: second"),
            ("c1", "commit: first"),
        ]))
        .expect("a commit can be undone");
        assert_eq!(
            (commit.kind, commit.target.as_str()),
            (UndoKind::Commit, "c1")
        );

        let checkout = plan_undo(&entries(&[
            ("b2", "checkout: moving from feature/x to main"),
            ("b1", "commit: work"),
        ]))
        .expect("a checkout can be undone");
        assert_eq!(checkout.kind, UndoKind::Checkout);
        assert_eq!(checkout.target_branch.as_deref(), Some("feature/x"));

        let detached = plan_undo(&entries(&[
            ("b2", "checkout: moving from 1a2b3c4d5e to main"),
            ("b1", "commit: work"),
        ]))
        .expect("a detached checkout can be undone");
        assert_eq!(detached.target_branch, None);

        let rebase = plan_undo(&entries(&[
            ("r3", "rebase (finish): returning to refs/heads/feature"),
            ("r2", "rebase (pick): change"),
            ("r1", "rebase (start): checkout main"),
            ("r0", "commit: before rebase"),
        ]))
        .expect("a rebase can be undone");
        assert_eq!(
            (rebase.kind, rebase.target.as_str()),
            (UndoKind::Rebase, "r0")
        );

        let merge = plan_undo(&entries(&[
            ("m1", "merge feature: Fast-forward"),
            ("m0", "commit: x"),
        ]))
        .expect("a merge can be undone");
        assert_eq!(merge.kind, UndoKind::Merge);
        let reset = plan_undo(&entries(&[
            ("x1", "reset: moving to HEAD~1"),
            ("x0", "commit: x"),
        ]))
        .expect("a reset can be undone");
        assert_eq!((reset.kind, reset.target.as_str()), (UndoKind::Reset, "x0"));
        assert_eq!(
            plan_undo(&entries(&[("i0", "commit (initial): first")])),
            None
        );
        assert_eq!(plan_undo(&[]), None);
    }
}
