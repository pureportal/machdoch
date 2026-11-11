use std::{path::Path, thread};

use serde::{Deserialize, Serialize};

use super::{
    branch_alignment, command_output_bounded, output_error, parse_numstat, repository_context,
    run_diff, run_optional, run_required, stack, WorkspaceGitPatch,
};

const MAX_GRAPH_COMMITS: usize = 300;
const MAX_COMMIT_FILES: usize = 500;
const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1024;
const GRAPH_LOG_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitGraphRequest {
    workspace_root: String,
    repository_root: String,
    scope: Option<WorkspaceGitGraphScope>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceGitGraphScope {
    #[default]
    Current,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceGitGraphRefKind {
    Head,
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitGraphRef {
    name: String,
    kind: WorkspaceGitGraphRefKind,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitGraphCommit {
    hash: String,
    short_hash: String,
    parents: Vec<String>,
    subject: String,
    author: String,
    authored_at: String,
    refs: Vec<WorkspaceGitGraphRef>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitGraphBase {
    branch: String,
    merge_base: String,
    ahead: u64,
    behind: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitGraph {
    repository_root: String,
    commits: Vec<WorkspaceGitGraphCommit>,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    base: Option<WorkspaceGitGraphBase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitCommitRequest {
    workspace_root: String,
    repository_root: String,
    commit: String,
    base: Option<String>,
    relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCommitFile {
    path: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    additions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deletions: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCommitDetail {
    hash: String,
    parents: Vec<String>,
    author: String,
    authored_at: String,
    message: String,
    files: Vec<WorkspaceGitCommitFile>,
    files_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    patch: Option<WorkspaceGitPatch>,
}

fn graph_ref(decoration: &str) -> Option<WorkspaceGitGraphRef> {
    let (kind, name) = if let Some(tag) = decoration.strip_prefix("tag: refs/tags/") {
        (WorkspaceGitGraphRefKind::Tag, tag)
    } else if let Some(branch) = decoration.strip_prefix("refs/heads/") {
        (WorkspaceGitGraphRefKind::Local, branch)
    } else if let Some(remote) = decoration.strip_prefix("refs/remotes/") {
        if remote.ends_with("/HEAD") {
            return None;
        }
        (WorkspaceGitGraphRefKind::Remote, remote)
    } else if decoration == "HEAD" {
        (WorkspaceGitGraphRefKind::Head, "HEAD")
    } else {
        return None;
    };
    Some(WorkspaceGitGraphRef {
        name: name.to_string(),
        kind,
    })
}

fn parse_decorations(decorations: &str) -> Vec<WorkspaceGitGraphRef> {
    decorations
        .split(", ")
        .flat_map(|decoration| match decoration.strip_prefix("HEAD -> ") {
            Some(branch) => vec![
                Some(WorkspaceGitGraphRef {
                    name: "HEAD".to_string(),
                    kind: WorkspaceGitGraphRefKind::Head,
                }),
                graph_ref(branch),
            ],
            None => vec![graph_ref(decoration.trim())],
        })
        .flatten()
        .collect()
}

fn parse_graph_log(output: &str) -> Vec<WorkspaceGitGraphCommit> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(7, '\u{1f}');
            Some(WorkspaceGitGraphCommit {
                hash: parts.next()?.to_string(),
                short_hash: parts.next()?.to_string(),
                parents: parts
                    .next()?
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
                author: parts.next()?.to_string(),
                authored_at: parts.next()?.to_string(),
                refs: parse_decorations(parts.next()?),
                subject: parts.next()?.to_string(),
            })
        })
        .collect()
}

fn divergence(repository: &Path, base: &str) -> Option<(String, u64, u64)> {
    let range = format!("{base}...HEAD");
    let (merge_base, counts) = thread::scope(|scope| {
        let merge_base =
            scope.spawn(|| run_optional("git", &["merge-base", base, "HEAD"], repository));
        let counts = run_optional(
            "git",
            &["rev-list", "--left-right", "--count", &range],
            repository,
        );
        (merge_base.join().ok().flatten(), counts)
    });
    let counts = counts?;
    let mut counts = counts.split_whitespace();
    let behind = counts.next()?.parse().ok()?;
    let ahead = counts.next()?.parse().ok()?;
    Some((merge_base.filter(|hash| !hash.is_empty())?, ahead, behind))
}

pub(super) fn load_graph(request: WorkspaceGitGraphRequest) -> Result<WorkspaceGitGraph, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    let scope = request.scope.unwrap_or_default();
    let (head, current, parents, references, upstream) = thread::scope(|scope| {
        let head = scope.spawn(|| {
            run_optional(
                "git",
                &["rev-parse", "--verify", "--quiet", "HEAD"],
                &repository,
            )
        });
        let parents = scope.spawn(|| stack::read_parents(&repository));
        let references = scope.spawn(|| branch_alignment::read_branch_references(&repository));
        let upstream = scope.spawn(|| {
            run_optional(
                "git",
                &[
                    "rev-parse",
                    "--abbrev-ref",
                    "--symbolic-full-name",
                    "@{upstream}",
                ],
                &repository,
            )
            .filter(|upstream| !upstream.is_empty())
        });
        let current = run_optional(
            "git",
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            &repository,
        )
        .filter(|branch| !branch.is_empty());
        (
            head.join().ok().flatten(),
            current,
            parents.join().unwrap_or_default(),
            references
                .join()
                .unwrap_or_else(|_| Err("Git stopped unexpectedly.".to_string())),
            upstream.join().ok().flatten(),
        )
    });
    if head.is_none() {
        return Ok(WorkspaceGitGraph {
            repository_root: repository.display().to_string(),
            commits: Vec::new(),
            truncated: false,
            base: None,
        });
    }
    let references = references?;
    let base_branch = current.as_deref().and_then(|branch| {
        parents
            .get(branch)
            .cloned()
            .or_else(|| branch_alignment::default_branch(&references, Some(branch)))
            .filter(|base| base != branch)
    });
    let base_revision = base_branch
        .as_deref()
        .and_then(|branch| branch_alignment::branch_revision(&references, branch));
    let limit = format!("--max-count={MAX_GRAPH_COMMITS}");
    let mut arguments = vec![
        "log",
        "--topo-order",
        "--decorate=full",
        limit.as_str(),
        "--format=%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s",
    ];
    match scope {
        WorkspaceGitGraphScope::All => arguments.extend(["--branches", "--remotes", "HEAD"]),
        WorkspaceGitGraphScope::Current => {
            arguments.push("HEAD");
            arguments.extend(upstream.as_deref());
            arguments.extend(base_revision.as_deref());
        }
    }
    arguments.push("--");
    let (log, base) = thread::scope(|scope| {
        let base = scope.spawn(|| {
            let branch = base_branch.as_deref()?;
            let (merge_base, ahead, behind) = divergence(&repository, base_revision.as_deref()?)?;
            Some(WorkspaceGitGraphBase {
                branch: branch.to_string(),
                merge_base,
                ahead,
                behind,
            })
        });
        let output = command_output_bounded("git", &arguments, &repository, GRAPH_LOG_BYTES);
        (output, base.join().ok().flatten())
    });
    let output = log?;
    if !output.status.success() {
        return Err(output_error("git", &arguments, &output));
    }
    let commits = parse_graph_log(&String::from_utf8_lossy(&output.stdout));
    Ok(WorkspaceGitGraph {
        repository_root: repository.display().to_string(),
        truncated: commits.len() >= MAX_GRAPH_COMMITS,
        commits,
        base,
    })
}

fn validate_commit(commit: &str) -> Result<&str, String> {
    let commit = commit.trim();
    if (4..=64).contains(&commit.len()) && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(commit)
    } else {
        Err("Select a valid commit.".to_string())
    }
}

fn parse_name_status(output: &str) -> Vec<(String, String)> {
    let mut records = output.split_terminator('\0');
    let mut files = Vec::new();
    while let (Some(status), Some(path)) = (records.next(), records.next()) {
        files.push((path.to_string(), status.chars().take(1).collect()));
    }
    files
}

const COMMIT_DIFF_ARGUMENTS: [&str; 7] = [
    "diff-tree",
    "-r",
    "--root",
    "--no-commit-id",
    "--no-renames",
    "-m",
    "--first-parent",
];

pub(super) fn load_commit(
    request: WorkspaceGitCommitRequest,
) -> Result<WorkspaceGitCommitDetail, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    let commit = validate_commit(&request.commit)?;
    let base = request.base.as_deref().map(validate_commit).transpose()?;
    let relative_path = request
        .relative_path
        .as_deref()
        .filter(|path| !path.is_empty() && !path.contains('\0'));
    let diff_arguments = |extra: &[&'static str]| {
        let mut arguments = match base {
            Some(_) => vec!["diff-tree", "-r", "--no-commit-id", "--no-renames"],
            None => COMMIT_DIFF_ARGUMENTS.to_vec(),
        };
        arguments.extend_from_slice(extra);
        arguments.extend(base);
        arguments.push(commit);
        arguments
    };
    let (header, names, stats, patch) = thread::scope(|scope| {
        let names = scope.spawn(|| {
            run_required(
                "git",
                &diff_arguments(&["-z", "--name-status"]),
                &repository,
            )
        });
        let stats =
            scope.spawn(|| run_required("git", &diff_arguments(&["-z", "--numstat"]), &repository));
        let patch = scope.spawn(|| {
            relative_path
                .map(|path| {
                    let mut arguments = diff_arguments(&[
                        "-p",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--no-color",
                        "--unified=3",
                    ]);
                    arguments.extend(["--", path]);
                    run_diff(&repository, "commit", &arguments, false)
                })
                .transpose()
        });
        let header = command_output_bounded(
            "git",
            &[
                "show",
                "-s",
                "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%B",
                commit,
                "--",
            ],
            &repository,
            MAX_COMMIT_MESSAGE_BYTES,
        );
        (
            header,
            names
                .join()
                .unwrap_or_else(|_| Err("Git stopped unexpectedly.".to_string())),
            stats
                .join()
                .unwrap_or_else(|_| Err("Git stopped unexpectedly.".to_string())),
            patch
                .join()
                .unwrap_or_else(|_| Err("Git stopped unexpectedly.".to_string())),
        )
    });
    let header = header?;
    if !header.status.success() {
        return Err("This commit is no longer available.".to_string());
    }
    let header = String::from_utf8_lossy(&header.stdout).into_owned();
    let mut parts = header.splitn(5, '\u{1f}');
    let hash = parts.next().unwrap_or_default().trim().to_string();
    let parents = parts
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let author = parts.next().unwrap_or_default().to_string();
    let authored_at = parts.next().unwrap_or_default().to_string();
    let message = parts.next().unwrap_or_default().trim_end().to_string();
    let stats = parse_numstat(&stats?);
    let mut names = parse_name_status(&names?);
    let files_truncated = names.len() > MAX_COMMIT_FILES;
    names.truncate(MAX_COMMIT_FILES);
    let files = names
        .into_iter()
        .map(|(path, status)| {
            let (additions, deletions) = stats.get(&path).copied().unwrap_or_default();
            WorkspaceGitCommitFile {
                path,
                status,
                additions,
                deletions,
            }
        })
        .collect();
    Ok(WorkspaceGitCommitDetail {
        hash,
        parents,
        author,
        authored_at,
        message,
        files,
        files_truncated,
        patch: patch?,
    })
}

#[cfg(test)]
mod tests {
    use std::{env, fs, path::PathBuf, time::SystemTime};

    use super::*;

    fn repository(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-git-history-{}-{unique}-{name}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("the repository should be created");
        for arguments in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "history@example.test"],
            vec!["config", "user.name", "History"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            run_required("git", &arguments, &root).expect("git setup should succeed");
        }
        root
    }

    fn commit(root: &Path, file: &str, content: &str, message: &str) {
        fs::write(root.join(file), content).expect("the file should write");
        run_required("git", &["add", "--", file], root).expect("the file should stage");
        run_required("git", &["commit", "--quiet", "-m", message], root)
            .expect("the commit should succeed");
    }

    fn graph(root: &Path, scope: WorkspaceGitGraphScope) -> WorkspaceGitGraph {
        load_graph(WorkspaceGitGraphRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            scope: Some(scope),
        })
        .expect("the graph should load")
    }

    #[test]
    fn parses_decorations_into_typed_refs() {
        assert_eq!(
            parse_decorations(
                "HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main, refs/remotes/origin/HEAD"
            ),
            vec![
                WorkspaceGitGraphRef {
                    name: "HEAD".to_string(),
                    kind: WorkspaceGitGraphRefKind::Head
                },
                WorkspaceGitGraphRef {
                    name: "main".to_string(),
                    kind: WorkspaceGitGraphRefKind::Local
                },
                WorkspaceGitGraphRef {
                    name: "v1.0".to_string(),
                    kind: WorkspaceGitGraphRefKind::Tag
                },
                WorkspaceGitGraphRef {
                    name: "origin/main".to_string(),
                    kind: WorkspaceGitGraphRefKind::Remote
                },
            ]
        );
        assert!(parse_decorations("").is_empty());
    }

    #[test]
    fn graph_shows_where_the_branch_forked_and_how_far_it_diverged() {
        let root = repository("fork");
        commit(&root, "base.txt", "base\n", "base");
        commit(&root, "base.txt", "second\n", "second");
        run_required("git", &["switch", "--quiet", "-c", "feature"], &root)
            .expect("the branch should be created");
        commit(&root, "feature.txt", "one\n", "feature one");
        commit(&root, "feature.txt", "two\n", "feature two");
        run_required("git", &["switch", "--quiet", "main"], &root).expect("main should switch");
        commit(&root, "main.txt", "main\n", "main moved");
        run_required("git", &["branch", "unrelated"], &root).expect("the branch should be created");
        run_required("git", &["switch", "--quiet", "feature"], &root)
            .expect("feature should switch");

        let current = graph(&root, WorkspaceGitGraphScope::Current);
        let base = current.base.as_ref().expect("the base should be reported");
        assert_eq!(base.branch, "main");
        assert_eq!((base.ahead, base.behind), (2, 1));
        let fork = current
            .commits
            .iter()
            .find(|commit| commit.hash == base.merge_base)
            .expect("the fork point should be in the graph");
        assert_eq!(fork.subject, "second");
        assert_eq!(current.commits.len(), 5);
        let head = current
            .commits
            .iter()
            .find(|commit| {
                commit
                    .refs
                    .iter()
                    .any(|reference| reference.kind == WorkspaceGitGraphRefKind::Head)
            })
            .expect("HEAD should be decorated");
        assert_eq!(head.subject, "feature two");
        assert!(head.refs.contains(&WorkspaceGitGraphRef {
            name: "feature".to_string(),
            kind: WorkspaceGitGraphRefKind::Local,
        }));
        assert!(!current.truncated);

        run_required("git", &["switch", "--quiet", "unrelated"], &root)
            .expect("unrelated should switch");
        commit(&root, "other.txt", "other\n", "unrelated work");
        run_required("git", &["switch", "--quiet", "feature"], &root)
            .expect("feature should switch");
        let all = graph(&root, WorkspaceGitGraphScope::All);
        assert_eq!(all.commits.len(), 6);
        assert!(all
            .commits
            .iter()
            .any(|commit| commit.subject == "unrelated work"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_repositories_have_an_empty_graph() {
        let root = repository("empty");
        let graph = graph(&root, WorkspaceGitGraphScope::Current);
        assert!(graph.commits.is_empty());
        assert!(graph.base.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn commit_detail_lists_files_with_line_counts_and_a_file_patch() {
        let root = repository("detail");
        commit(&root, "kept.txt", "one\ntwo\n", "base");
        fs::write(root.join("kept.txt"), "one\nthree\nfour\n").expect("the edit should write");
        fs::write(root.join("added.txt"), "new\n").expect("the file should write");
        run_required("git", &["add", "."], &root).expect("the changes should stage");
        run_required(
            "git",
            &["commit", "--quiet", "-m", "change\n\nBody text"],
            &root,
        )
        .expect("the commit should succeed");
        let head = run_required("git", &["rev-parse", "HEAD"], &root).expect("HEAD should resolve");

        let detail = load_commit(WorkspaceGitCommitRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            commit: head.clone(),
            base: None,
            relative_path: Some("kept.txt".to_string()),
        })
        .expect("the commit should load");
        assert_eq!(detail.hash, head);
        assert_eq!(detail.message, "change\n\nBody text");
        assert_eq!(
            detail.files,
            vec![
                WorkspaceGitCommitFile {
                    path: "added.txt".to_string(),
                    status: "A".to_string(),
                    additions: Some(1),
                    deletions: Some(0),
                },
                WorkspaceGitCommitFile {
                    path: "kept.txt".to_string(),
                    status: "M".to_string(),
                    additions: Some(2),
                    deletions: Some(1),
                },
            ]
        );
        let patch = detail.patch.expect("the file patch should load");
        assert!(patch.content.contains("+three"));
        assert!(!patch.content.contains("added.txt"));

        let root_commit = run_required("git", &["rev-list", "--max-parents=0", "HEAD"], &root)
            .expect("the root commit should resolve");
        let first = load_commit(WorkspaceGitCommitRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            commit: root_commit.clone(),
            base: None,
            relative_path: None,
        })
        .expect("the root commit should load");
        assert_eq!(first.files.len(), 1);
        assert!(first.patch.is_none());

        fs::write(root.join("later.txt"), "later\n").expect("the file should write");
        run_required("git", &["add", "later.txt"], &root).expect("the file should stage");
        run_required("git", &["commit", "--quiet", "-m", "later"], &root)
            .expect("the commit should succeed");
        let latest =
            run_required("git", &["rev-parse", "HEAD"], &root).expect("HEAD should resolve");
        let range = load_commit(WorkspaceGitCommitRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            commit: latest,
            base: Some(root_commit),
            relative_path: Some("later.txt".to_string()),
        })
        .expect("the range should load");
        assert_eq!(
            range
                .files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["added.txt", "kept.txt", "later.txt"]
        );
        assert!(range
            .patch
            .expect("the range patch should load")
            .content
            .contains("+later"));
        assert!(load_commit(WorkspaceGitCommitRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            commit: "--all".to_string(),
            base: None,
            relative_path: None,
        })
        .is_err());
        let _ = fs::remove_dir_all(root);
    }
}
