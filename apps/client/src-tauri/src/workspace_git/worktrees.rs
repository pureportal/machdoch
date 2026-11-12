use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use super::{command_succeeds, git_directories, run_optional, run_required};

const MAX_WORKTREE_STATUS: usize = 12;
const MAX_WORKTREE_SLUG_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitWorktree {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    head: String,
    main: bool,
    current: bool,
    detached: bool,
    locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    lock_reason: Option<String>,
    prunable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    changes: Option<usize>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ListedWorktree {
    path: PathBuf,
    head: String,
    branch: Option<String>,
    detached: bool,
    bare: bool,
    locked: Option<String>,
    prunable: bool,
}

fn parse_worktree_list(output: &str) -> Vec<ListedWorktree> {
    let mut worktrees = Vec::new();
    let mut current: Option<ListedWorktree> = None;
    for field in output.split('\0') {
        if field.is_empty() {
            worktrees.extend(current.take());
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        if key == "worktree" {
            worktrees.extend(current.take());
            current = Some(ListedWorktree {
                path: PathBuf::from(value),
                ..ListedWorktree::default()
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        match key {
            "HEAD" => entry.head = value.to_string(),
            "branch" => {
                entry.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_string(),
                )
            }
            "detached" => entry.detached = true,
            "bare" => entry.bare = true,
            "locked" => entry.locked = Some(value.to_string()),
            "prunable" => entry.prunable = true,
            _ => {}
        }
    }
    worktrees.extend(current);
    worktrees
}

fn count_changes(status: &str) -> usize {
    let mut count = 0;
    let mut records = status.split('\0').filter(|record| record.len() > 3);
    while let Some(record) = records.next() {
        count += 1;
        if matches!(record.as_bytes()[0], b'R' | b'C') {
            records.next();
        }
    }
    count
}

fn listed_worktrees(repository: &Path) -> Result<Vec<ListedWorktree>, String> {
    run_required(
        "git",
        &["worktree", "list", "--porcelain", "-z"],
        repository,
    )
    .map(|output| parse_worktree_list(&output))
}

pub(super) fn read_worktrees(repository: &Path) -> Vec<WorkspaceGitWorktree> {
    let current = fs::canonicalize(repository).ok();
    run_optional(
        "git",
        &["worktree", "list", "--porcelain", "-z"],
        repository,
    )
    .map(|output| parse_worktree_list(&output))
    .unwrap_or_default()
    .into_iter()
    .enumerate()
    .filter(|(_, worktree)| !worktree.bare)
    .map(|(index, worktree)| {
        let canonical = fs::canonicalize(&worktree.path).ok();
        let changes = canonical
            .as_deref()
            .filter(|_| index < MAX_WORKTREE_STATUS)
            .and_then(|path| {
                run_optional(
                    "git",
                    &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
                    path,
                )
            })
            .map(|status| count_changes(&status));
        WorkspaceGitWorktree {
            path: canonical.as_deref().map_or_else(
                || worktree.path.display().to_string(),
                crate::desktop_task::format_path_for_ui,
            ),
            branch: worktree.branch,
            head: worktree.head,
            main: index == 0,
            current: canonical.is_some() && canonical == current,
            detached: worktree.detached,
            locked: worktree.locked.is_some(),
            lock_reason: worktree.locked.filter(|reason| !reason.is_empty()),
            prunable: worktree.prunable,
            changes,
        }
    })
    .collect()
}

fn worktree_slug(branch: &str) -> String {
    let mut slug = String::new();
    for character in branch.chars() {
        let keep = character.is_ascii_alphanumeric() || matches!(character, '_' | '.');
        if keep {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug
        .trim_matches(['-', '.'])
        .chars()
        .take(MAX_WORKTREE_SLUG_CHARS)
        .collect();
    let slug = slug.trim_matches(['-', '.']);
    if slug.is_empty() {
        "worktree".to_string()
    } else {
        slug.to_string()
    }
}

fn worktree_location(repository: &Path, branch: &str) -> Result<PathBuf, String> {
    let directories = git_directories(repository)
        .ok_or_else(|| "The selected folder is not a Git repository.".to_string())?;
    let common_dir = fs::canonicalize(&directories.common_dir).unwrap_or(directories.common_dir);
    let main_root = match common_dir.file_name() {
        Some(name) if name == ".git" => common_dir.parent().map(Path::to_path_buf),
        _ => None,
    }
    .unwrap_or_else(|| repository.to_path_buf());
    let main_root = fs::canonicalize(&main_root)
        .map(|path| PathBuf::from(crate::desktop_task::format_path_for_ui(&path)))
        .unwrap_or(main_root);
    let (Some(parent), Some(name)) = (main_root.parent(), main_root.file_name()) else {
        return Err("Worktrees need a repository inside a folder.".to_string());
    };
    let base = parent.join(format!("{}.worktrees", name.to_string_lossy()));
    let slug = worktree_slug(branch);
    let candidate = (1..=99)
        .map(|attempt| {
            if attempt == 1 {
                base.join(&slug)
            } else {
                base.join(format!("{slug}-{attempt}"))
            }
        })
        .find(|path| !path.exists())
        .ok_or_else(|| format!("Remove unused worktrees in {} first.", base.display()))?;
    fs::create_dir_all(&base)
        .map_err(|error| format!("Could not create {}: {error}", base.display()))?;
    Ok(candidate)
}

fn remote_branch(repository: &Path, branch: &str) -> Result<Option<String>, String> {
    let output = run_required(
        "git",
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            &format!("refs/remotes/*/{branch}"),
        ],
        repository,
    )?;
    let mut matches = output.lines().filter(|line| !line.is_empty());
    Ok(match (matches.next(), matches.next()) {
        (Some(remote), None) => Some(remote.to_string()),
        _ => None,
    })
}

pub(super) fn add_worktree(
    repository: &Path,
    branch: &str,
    start_point: Option<&str>,
) -> Result<(), String> {
    let local = command_succeeds(
        "git",
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
        repository,
    )?;
    let remote = if local || start_point.is_some() {
        None
    } else {
        remote_branch(repository, branch)?
    };
    let location = worktree_location(repository, branch)?;
    let location = location.display().to_string();
    let mut arguments = vec!["worktree", "add"];
    if local {
        arguments.extend([location.as_str(), branch]);
    } else if let Some(remote) = remote.as_deref() {
        arguments.extend(["--track", "-b", branch, location.as_str(), remote]);
    } else {
        arguments.extend([
            "-b",
            branch,
            location.as_str(),
            start_point.unwrap_or("HEAD"),
        ]);
    }
    run_required("git", &arguments, repository)?;
    Ok(())
}

fn listed_worktree(repository: &Path, requested: &str) -> Result<(bool, bool, PathBuf), String> {
    let requested_path = PathBuf::from(requested.trim());
    let requested_canonical = fs::canonicalize(&requested_path).ok();
    let current = fs::canonicalize(repository).ok();
    listed_worktrees(repository)?
        .into_iter()
        .enumerate()
        .find_map(|(index, worktree)| {
            let canonical = fs::canonicalize(&worktree.path).ok();
            let same = match (&canonical, &requested_canonical) {
                (Some(listed), Some(requested)) => listed == requested,
                _ => worktree.path == requested_path,
            };
            same.then(|| {
                (
                    index == 0,
                    canonical.is_some() && canonical == current,
                    worktree.path,
                )
            })
        })
        .ok_or_else(|| "Select a worktree of this repository.".to_string())
}

pub(super) fn change_worktree(
    repository: &Path,
    action: &str,
    requested: &str,
    force: bool,
) -> Result<(), String> {
    let (main, current, path) = listed_worktree(repository, requested)?;
    if main {
        return Err("The main worktree cannot be changed here.".to_string());
    }
    let path = path.display().to_string();
    let arguments: Vec<&str> = match action {
        "remove-worktree" if current => {
            return Err("Open another worktree before removing this one.".to_string())
        }
        "remove-worktree" if force => vec!["worktree", "remove", "--force", &path],
        "remove-worktree" => vec!["worktree", "remove", &path],
        "lock-worktree" => vec!["worktree", "lock", &path],
        _ => vec!["worktree", "unlock", &path],
    };
    run_required("git", &arguments, repository)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{count_changes, parse_worktree_list, worktree_slug, ListedWorktree};
    use std::path::PathBuf;

    #[test]
    fn parses_porcelain_worktree_records() {
        let output = "worktree /repo\0HEAD 1111\0branch refs/heads/main\0\0worktree /repo.worktrees/fix\0HEAD 2222\0detached\0locked on usb\0\0worktree /gone\0HEAD 3333\0branch refs/heads/old\0prunable gitdir file points to non-existent location\0\0";
        assert_eq!(
            parse_worktree_list(output),
            vec![
                ListedWorktree {
                    path: PathBuf::from("/repo"),
                    head: "1111".to_string(),
                    branch: Some("main".to_string()),
                    ..ListedWorktree::default()
                },
                ListedWorktree {
                    path: PathBuf::from("/repo.worktrees/fix"),
                    head: "2222".to_string(),
                    detached: true,
                    locked: Some("on usb".to_string()),
                    ..ListedWorktree::default()
                },
                ListedWorktree {
                    path: PathBuf::from("/gone"),
                    head: "3333".to_string(),
                    branch: Some("old".to_string()),
                    prunable: true,
                    ..ListedWorktree::default()
                },
            ]
        );
    }

    #[test]
    fn counts_status_records_once_per_change() {
        assert_eq!(count_changes(" M a.ts\0R  new.ts\0old.ts\0?? b.ts\0"), 3);
        assert_eq!(count_changes(""), 0);
    }

    #[test]
    fn derives_safe_folder_names_from_branches() {
        assert_eq!(
            worktree_slug("feature/PLAT-12 Crash on upload"),
            "feature-plat-12-crash-on-upload"
        );
        assert_eq!(worktree_slug("../../etc"), "etc");
        assert_eq!(worktree_slug("/"), "worktree");
    }
}
