use std::{
    collections::HashSet,
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

use super::{branch_alignment, git_directories};

const TRUNK_NAMES: [&str; 2] = ["main", "master"];
const MAX_REFLOG_TAIL_BYTES: u64 = 256 * 1024;
const MAX_RECENT_BRANCHES: usize = 20;

fn packed_references(common_dir: &Path) -> HashSet<String> {
    fs::read_to_string(common_dir.join("packed-refs"))
        .map(|text| {
            text.lines()
                .filter(|line| !line.starts_with('#') && !line.starts_with('^'))
                .filter_map(|line| {
                    line.split_once(' ')
                        .map(|(_, name)| name.trim().to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn reference_exists(common_dir: &Path, packed: &HashSet<String>, name: &str) -> bool {
    common_dir.join(name).is_file() || packed.contains(name)
}

pub(super) fn trunk_references(repository: &Path) -> branch_alignment::BranchReferences {
    let Some(directories) = git_directories(repository) else {
        return branch_alignment::BranchReferences::default();
    };
    let common_dir = directories.common_dir;
    let packed = packed_references(&common_dir);
    let mut entries: Vec<(String, String)> = Vec::new();
    for name in TRUNK_NAMES {
        let reference = format!("refs/heads/{name}");
        if reference_exists(&common_dir, &packed, &reference) {
            entries.push((reference, String::new()));
        }
    }
    let mut remotes = fs::read_dir(common_dir.join("refs").join("remotes"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    remotes.extend(packed.iter().filter_map(|name| {
        name.strip_prefix("refs/remotes/")
            .and_then(|rest| rest.split_once('/'))
            .map(|(remote, _)| remote.to_string())
    }));
    let mut remotes = remotes.into_iter().collect::<Vec<_>>();
    remotes.sort();
    for remote in remotes {
        let head = format!("refs/remotes/{remote}/HEAD");
        if let Some(target) = fs::read_to_string(common_dir.join(&head))
            .ok()
            .and_then(|content| {
                content
                    .trim()
                    .strip_prefix("ref:")
                    .map(|target| target.trim().to_string())
            })
        {
            entries.push((head, target));
        }
        for name in TRUNK_NAMES {
            let reference = format!("refs/remotes/{remote}/{name}");
            if reference_exists(&common_dir, &packed, &reference) {
                entries.push((reference, String::new()));
            }
        }
    }
    branch_alignment::references_from(
        entries
            .iter()
            .map(|(name, target)| (name.as_str(), target.as_str(), 0)),
    )
}

fn reflog_tail(path: &Path) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let length = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let start = length.saturating_sub(MAX_REFLOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
        text
    } else {
        text.split_once('\n')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default()
    }
}

fn looks_like_commit(name: &str) -> bool {
    (7..=64).contains(&name.len()) && name.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn recent_branches_from_reflog(reflog: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in reflog.lines().rev() {
        let Some((_, message)) = line.split_once('\t') else {
            continue;
        };
        let Some((from, to)) = message
            .strip_prefix("checkout: moving from ")
            .and_then(|rest| rest.split_once(" to "))
        else {
            continue;
        };
        for name in [to.trim(), from.trim()] {
            if name.is_empty() || looks_like_commit(name) || names.iter().any(|known| known == name)
            {
                continue;
            }
            names.push(name.to_string());
        }
        if names.len() >= MAX_RECENT_BRANCHES {
            break;
        }
    }
    names
}

pub(super) fn recent_branches(repository: &Path) -> Vec<String> {
    git_directories(repository)
        .map(|directories| {
            recent_branches_from_reflog(&reflog_tail(
                &directories.git_dir.join("logs").join("HEAD"),
            ))
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::{env, time::SystemTime};

    use super::*;
    use crate::workspace_git::run_required;

    #[test]
    fn lists_recently_checked_out_branches_newest_first() {
        let reflog = [
            "a b A <a@test> 1 +0000\tcommit (initial): first",
            "a b A <a@test> 2 +0000\tcheckout: moving from main to feature/a",
            "a b A <a@test> 3 +0000\tcheckout: moving from feature/a to 1a2b3c4d",
            "a b A <a@test> 4 +0000\tcheckout: moving from 1a2b3c4d to main",
            "a b A <a@test> 5 +0000\tcheckout: moving from main to feature/b",
        ]
        .join("\n");
        assert_eq!(
            recent_branches_from_reflog(&reflog),
            vec!["feature/b", "main", "feature/a"]
        );
    }

    #[test]
    fn reads_trunk_references_without_running_git() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root =
            env::temp_dir().join(format!("machdoch-git-refs-{}-{unique}", std::process::id()));
        fs::create_dir_all(&root).expect("the repository should be created");
        run_required("git", &["init", "-b", "main"], &root).expect("git init should succeed");
        run_required("git", &["config", "user.email", "refs@example.test"], &root).expect("email");
        run_required("git", &["config", "user.name", "Refs"], &root).expect("name");
        run_required("git", &["commit", "--allow-empty", "-m", "first"], &root).expect("commit");
        run_required(
            "git",
            &["update-ref", "refs/remotes/origin/develop", "HEAD"],
            &root,
        )
        .expect("the remote ref should be created");
        run_required(
            "git",
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/develop",
            ],
            &root,
        )
        .expect("the remote head should be created");
        run_required("git", &["pack-refs", "--all"], &root).expect("refs should pack");
        run_required("git", &["switch", "-c", "topic"], &root).expect("switch");
        let references = trunk_references(&root);
        assert_eq!(
            branch_alignment::default_branch(&references, Some("topic")).as_deref(),
            Some("develop")
        );
        assert_eq!(recent_branches(&root), vec!["topic", "main"]);
        let _ = fs::remove_dir_all(root);
    }
}
