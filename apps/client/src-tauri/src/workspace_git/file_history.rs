use std::{collections::HashMap, path::Path};

use chrono::DateTime;
use serde::{Deserialize, Serialize};

use super::{
    command_output_bounded, history::validate_commit, repository_context, run_required,
    WorkspaceGitCommit,
};

const MAX_FILE_HISTORY: usize = 200;
const MAX_REVISION_FILE_BYTES: usize = 8 * 1024 * 1024;
const UNCOMMITTED: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitFileRequest {
    pub(super) workspace_root: String,
    pub(super) repository_root: String,
    pub(super) relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitBlameRequest {
    workspace_root: String,
    repository_root: String,
    relative_path: String,
    revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitFileCommit {
    #[serde(flatten)]
    commit: WorkspaceGitCommit,
    path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitFileHistory {
    relative_path: String,
    commits: Vec<WorkspaceGitFileCommit>,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBlameRange {
    start_line: u64,
    line_count: u64,
    commit: String,
    short_hash: String,
    author: String,
    authored_at: String,
    summary: String,
    uncommitted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBlame {
    relative_path: String,
    ranges: Vec<WorkspaceGitBlameRange>,
}

pub(super) fn validate_relative_path(relative_path: &str) -> Result<&str, String> {
    let path = relative_path.trim();
    if path.is_empty()
        || path.len() > 4_096
        || path.chars().any(char::is_control)
        || Path::new(path).is_absolute()
        || path.split(['/', '\\']).any(|part| part == "..")
    {
        return Err("Select a file in this repository.".to_string());
    }
    Ok(path)
}

fn parse_file_history(output: &str) -> Vec<WorkspaceGitFileCommit> {
    output
        .split('\u{1e}')
        .filter_map(|record| {
            let (header, paths) = record.split_once(['\n', '\0'])?;
            let mut fields = header.split('\u{1f}');
            let commit = WorkspaceGitCommit {
                hash: fields.next()?.to_string(),
                short_hash: fields.next()?.to_string(),
                subject: fields.next()?.to_string(),
                author: fields.next()?.to_string(),
                authored_at: fields.next()?.to_string(),
            };
            let path = paths
                .split(['\0', '\n'])
                .map(str::trim)
                .find(|path| !path.is_empty())?
                .to_string();
            Some(WorkspaceGitFileCommit { commit, path })
        })
        .collect()
}

pub(super) fn load_file_history(
    request: WorkspaceGitFileRequest,
) -> Result<WorkspaceGitFileHistory, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    let relative_path = validate_relative_path(&request.relative_path)?;
    let output = run_required(
        "git",
        &[
            "log",
            "--follow",
            &format!("-{}", MAX_FILE_HISTORY + 1),
            "--name-only",
            "-z",
            "--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%aI",
            "--",
            relative_path,
        ],
        &repository,
    )?;
    let mut commits = parse_file_history(&output);
    let truncated = commits.len() > MAX_FILE_HISTORY;
    commits.truncate(MAX_FILE_HISTORY);
    Ok(WorkspaceGitFileHistory {
        relative_path: relative_path.to_string(),
        commits,
        truncated,
    })
}

#[derive(Default)]
struct BlameCommit {
    author: String,
    author_time: i64,
    summary: String,
}

fn authored_at(seconds: i64) -> String {
    DateTime::from_timestamp(seconds, 0)
        .map(|time| time.to_rfc3339())
        .unwrap_or_default()
}

fn parse_blame(output: &str) -> Vec<WorkspaceGitBlameRange> {
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    let mut groups: Vec<(String, u64, u64)> = Vec::new();
    let mut current = String::new();
    for line in output.lines() {
        if line.starts_with('\t') {
            continue;
        }
        let fields = line.split(' ').collect::<Vec<_>>();
        let is_header = fields.len() >= 3
            && fields[0].len() == 40
            && fields[0].bytes().all(|byte| byte.is_ascii_hexdigit());
        if is_header {
            current = fields[0].to_string();
            commits.entry(current.clone()).or_default();
            if let (Some(start), Some(count)) = (
                fields.get(2).and_then(|value| value.parse().ok()),
                fields.get(3).and_then(|value| value.parse().ok()),
            ) {
                groups.push((current.clone(), start, count));
            }
            continue;
        }
        let Some(commit) = commits.get_mut(&current) else {
            continue;
        };
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "author" => commit.author = value.to_string(),
            "author-time" => commit.author_time = value.parse().unwrap_or_default(),
            "summary" => commit.summary = value.to_string(),
            _ => {}
        }
    }
    groups
        .into_iter()
        .map(|(hash, start_line, line_count)| {
            let details = commits.get(&hash);
            let uncommitted = hash == UNCOMMITTED;
            WorkspaceGitBlameRange {
                start_line,
                line_count,
                short_hash: hash.chars().take(8).collect(),
                author: details
                    .map(|commit| commit.author.clone())
                    .unwrap_or_default(),
                authored_at: details
                    .map(|commit| authored_at(commit.author_time))
                    .unwrap_or_default(),
                summary: details
                    .map(|commit| commit.summary.clone())
                    .unwrap_or_default(),
                commit: hash,
                uncommitted,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitFileRevision {
    relative_path: String,
    revision: String,
    content: Option<String>,
    binary: bool,
}

pub(super) fn load_file_revision(
    request: WorkspaceGitBlameRequest,
) -> Result<WorkspaceGitFileRevision, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    let relative_path = validate_relative_path(&request.relative_path)?;
    let revision = request
        .revision
        .as_deref()
        .map(validate_commit)
        .transpose()?
        .unwrap_or("HEAD");
    let object = format!("{revision}:{relative_path}");
    let output = command_output_bounded(
        "git",
        &["show", &object],
        &repository,
        MAX_REVISION_FILE_BYTES + 1,
    )?;
    let bytes = output.status.success().then_some(output.stdout);
    if bytes
        .as_ref()
        .is_some_and(|bytes| bytes.len() > MAX_REVISION_FILE_BYTES)
    {
        return Err("This file is too large to compare.".to_string());
    }
    let binary = bytes.as_ref().is_some_and(|bytes| bytes.contains(&0));
    Ok(WorkspaceGitFileRevision {
        relative_path: relative_path.to_string(),
        revision: revision.to_string(),
        content: bytes
            .filter(|_| !binary)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
        binary,
    })
}

pub(super) fn load_blame(request: WorkspaceGitBlameRequest) -> Result<WorkspaceGitBlame, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    let relative_path = validate_relative_path(&request.relative_path)?;
    let revision = request
        .revision
        .as_deref()
        .map(validate_commit)
        .transpose()?;
    let mut arguments = vec!["blame", "--porcelain"];
    arguments.extend(revision);
    arguments.extend(["--", relative_path]);
    let output = run_required("git", &arguments, &repository)?;
    Ok(WorkspaceGitBlame {
        relative_path: relative_path.to_string(),
        ranges: parse_blame(&output),
    })
}

#[cfg(test)]
mod tests {
    use std::{env, fs, time::SystemTime};

    use super::*;
    use crate::workspace_git::test_repository;

    fn repository(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-git-{name}-{}-{unique}",
            std::process::id()
        ));
        test_repository(&root);
        root
    }

    #[test]
    fn file_history_follows_renames() {
        let root = repository("file-history");
        fs::write(root.join("tracked.txt"), "base\nsecond\n").expect("the edit should write");
        run_required("git", &["commit", "--quiet", "-am", "second"], &root).expect("commit");
        run_required("git", &["mv", "tracked.txt", "renamed.txt"], &root).expect("rename");
        run_required("git", &["commit", "--quiet", "-m", "rename"], &root).expect("commit");
        let workspace_root = root.display().to_string();
        let history = load_file_history(WorkspaceGitFileRequest {
            workspace_root: workspace_root.clone(),
            repository_root: workspace_root,
            relative_path: "renamed.txt".to_string(),
        })
        .expect("the history should load");
        assert_eq!(
            history
                .commits
                .iter()
                .map(|commit| (commit.commit.subject.as_str(), commit.path.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("rename", "renamed.txt"),
                ("second", "tracked.txt"),
                ("base", "tracked.txt")
            ]
        );
        assert!(!history.truncated);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn blame_groups_lines_by_commit_and_marks_uncommitted_lines() {
        let root = repository("blame");
        fs::write(root.join("tracked.txt"), "base\nsecond\n").expect("the edit should write");
        run_required("git", &["commit", "--quiet", "-am", "second line"], &root).expect("commit");
        fs::write(root.join("tracked.txt"), "base\nsecond\nlocal\n")
            .expect("the edit should write");
        let workspace_root = root.display().to_string();
        let blame = load_blame(WorkspaceGitBlameRequest {
            workspace_root: workspace_root.clone(),
            repository_root: workspace_root,
            relative_path: "tracked.txt".to_string(),
            revision: None,
        })
        .expect("the blame should load");
        let summaries = blame
            .ranges
            .iter()
            .map(|range| (range.start_line, range.summary.as_str(), range.uncommitted))
            .collect::<Vec<_>>();
        assert_eq!(summaries[0], (1, "base", false));
        assert_eq!(summaries[1], (2, "second line", false));
        assert_eq!(summaries[2].0, 3);
        assert!(summaries[2].2);
        assert!(blame.ranges[0].authored_at.contains('T'));
        assert!(validate_relative_path("../outside.txt").is_err());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn reads_a_file_as_it_was_committed() {
        let repository = repository("revision");
        fs::write(repository.join("notes.txt"), "committed\n").expect("the file should be written");
        run_required("git", &["add", "notes.txt"], &repository).expect("the file should stage");
        run_required(
            "git",
            &["commit", "--quiet", "-m", "Add notes"],
            &repository,
        )
        .expect("the commit should succeed");
        fs::write(repository.join("notes.txt"), "edited\n").expect("the file should be edited");
        fs::write(repository.join("new.txt"), "new\n").expect("the file should be written");
        let root = repository.display().to_string();
        let read = |path: &str| {
            load_file_revision(WorkspaceGitBlameRequest {
                workspace_root: root.clone(),
                repository_root: root.clone(),
                relative_path: path.to_string(),
                revision: None,
            })
            .expect("the revision should load")
        };
        let committed = read("notes.txt");
        assert_eq!(committed.content.as_deref(), Some("committed\n"));
        assert_eq!(committed.revision, "HEAD");
        assert!(!committed.binary);
        assert_eq!(read("new.txt").content, None);
        let _ = fs::remove_dir_all(&repository);
    }
}
