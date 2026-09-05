use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

use crate::child_process::SupervisedChild;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Semaphore;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_GIT_ENTRIES: usize = 300;
const MAX_GIT_DIFF_BYTES: usize = 128 * 1024;
const MAX_GIT_ERROR_BYTES: usize = 32 * 1024;
const MAX_GIT_COMMAND_BYTES: usize = 32 * 1024 * 1024;
static GIT_READ_PERMITS: OnceLock<Semaphore> = OnceLock::new();

fn git_read_permits() -> &'static Semaphore {
    GIT_READ_PERMITS.get_or_init(|| Semaphore::new(4))
}

async fn run_git_read<R: Send + 'static>(
    read: impl FnOnce() -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    let permit = git_read_permits()
        .acquire()
        .await
        .map_err(|error| format!("The workspace Git reader is unavailable: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        read()
    })
    .await
    .map_err(|error| format!("The workspace Git reader stopped unexpectedly: {error}"))?
}
const MAX_REPOSITORY_SCAN_DIRECTORIES: usize = 50_000;
const MAX_DISCOVERED_REPOSITORIES: usize = 256;
const MAX_REPOSITORY_SCAN_ISSUES: usize = 20;
const REPOSITORY_SCAN_IGNORED_DIRECTORIES: &[&str] = &[
    ".cache",
    ".gradle",
    ".tox",
    ".venv",
    "__pycache__",
    "node_modules",
    "target",
    "venv",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitChange {
    status: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    staged: bool,
    unstaged: bool,
    untracked: bool,
    conflicted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitPatch {
    kind: String,
    content: String,
    binary: bool,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitDiff {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    patches: Vec<WorkspaceGitPatch>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBranch {
    name: String,
    commit: String,
    current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRemote {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fetch_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    push_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCommit {
    hash: String,
    short_hash: String,
    subject: String,
    author: String,
    authored_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePullRequest {
    number: u64,
    title: String,
    state: String,
    url: String,
    head_branch: String,
    base_branch: String,
    draft: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePullRequestOverview {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    items: Vec<WorkspacePullRequest>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRepository {
    repository_root: String,
    relative_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRepositoryDiscovery {
    workspace_root: String,
    repositories: Vec<WorkspaceGitRepository>,
    scan_limited: bool,
    issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitOverview {
    workspace_root: String,
    repository_root: String,
    branch: String,
    detached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
    clean: bool,
    staged_count: usize,
    unstaged_count: usize,
    untracked_count: usize,
    conflicted_count: usize,
    total_changes: usize,
    changes: Vec<WorkspaceGitChange>,
    changes_truncated: bool,
    local_branches: Vec<WorkspaceGitBranch>,
    remote_branches: Vec<WorkspaceGitBranch>,
    remotes: Vec<WorkspaceGitRemote>,
    #[serde(skip_serializing_if = "Option::is_none")]
    head_commit: Option<WorkspaceGitCommit>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitActionRequest {
    workspace_root: String,
    repository_root: String,
    action: String,
    branch_name: Option<String>,
    remote_name: Option<String>,
    remote_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitDiffRequest {
    workspace_root: String,
    repository_root: String,
    relative_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitRepositoryRequest {
    workspace_root: String,
    repository_root: String,
}

fn configured_command(program: &str, args: &[&str], cwd: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn command_output(program: &str, args: &[&str], cwd: &Path) -> Result<Output, String> {
    let output = command_output_bounded(program, args, cwd, MAX_GIT_COMMAND_BYTES + 1)?;
    if output.stdout.len() > MAX_GIT_COMMAND_BYTES {
        return Err(format!(
            "{program} output exceeded the 32 MB workspace command limit."
        ));
    }
    Ok(output)
}

fn read_bounded<R: Read>(mut reader: R, limit: usize) -> io::Result<Vec<u8>> {
    let mut retained = Vec::with_capacity(limit.min(8 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(retained);
        }
        let keep = count.min(limit.saturating_sub(retained.len()));
        retained.extend_from_slice(&buffer[..keep]);
    }
}

fn command_output_bounded(
    program: &str,
    args: &[&str],
    cwd: &Path,
    stdout_limit: usize,
) -> Result<Output, String> {
    let mut command = configured_command(program, args, cwd);
    let mut child = SupervisedChild::spawn_with_required_isolation(&mut command)
        .map_err(|error| format!("Failed to run {program}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Failed to read {program} output."))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Failed to read {program} errors."))?;
    let stdout_worker = thread::Builder::new()
        .name("workspace-git-stdout".to_string())
        .spawn(move || read_bounded(stdout, stdout_limit))
        .map_err(|error| {
            let _ = child.terminate_and_reap();
            format!("Failed to read {program} output: {error}")
        })?;
    let stderr_worker = match thread::Builder::new()
        .name("workspace-git-stderr".to_string())
        .spawn(move || read_bounded(stderr, MAX_GIT_ERROR_BYTES))
    {
        Ok(worker) => worker,
        Err(error) => {
            let _ = child.terminate_and_reap();
            let _ = stdout_worker.join();
            return Err(format!("Failed to read {program} errors: {error}"));
        }
    };
    let deadline = Instant::now() + Duration::from_secs(120);
    let status_result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.terminate_and_reap();
                break Err(format!("{program} timed out after 120 seconds."));
            }
            Err(error) => {
                let _ = child.terminate_and_reap();
                break Err(format!("Failed to wait for {program}: {error}"));
            }
        }
    };
    // Reap descendants before joining: helpers can inherit pipes and outlive git.
    let stdout_result = stdout_worker.join();
    let stderr_result = stderr_worker.join();
    let status = status_result?;
    let stdout = stdout_result
        .map_err(|_| format!("The {program} output reader stopped unexpectedly."))?
        .map_err(|error| format!("Failed to read {program} output: {error}"))?;
    let stderr = stderr_result
        .map_err(|_| format!("The {program} error reader stopped unexpectedly."))?
        .map_err(|error| format!("Failed to read {program} errors: {error}"))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn output_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn output_error(program: &str, args: &[&str], output: &Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let operation = args
        .first()
        .map(|argument| format!(" {argument}"))
        .unwrap_or_default();
    if detail.is_empty() {
        format!("{program}{operation} exited with status {}.", output.status,)
    } else {
        format!("{program}{operation} failed: {detail}")
    }
}

fn run_required(program: &str, args: &[&str], cwd: &Path) -> Result<String, String> {
    let output = command_output(program, args, cwd)?;
    if output.status.success() {
        Ok(output_text(&output))
    } else {
        Err(output_error(program, args, &output))
    }
}

fn run_optional(program: &str, args: &[&str], cwd: &Path) -> Option<String> {
    command_output(program, args, cwd)
        .ok()
        .filter(|output| output.status.success())
        .map(|output| output_text(&output))
}

fn canonical_workspace_root(workspace_root: &str) -> Result<PathBuf, String> {
    let trimmed = workspace_root.trim();
    if trimmed.is_empty() {
        return Err("Select a workspace before loading Git information.".to_string());
    }
    let root = fs::canonicalize(trimmed)
        .map_err(|error| format!("Workspace {trimmed} is unavailable: {error}"))?;
    if !root.is_dir() {
        return Err(format!("Workspace {} is not a directory.", root.display()));
    }
    Ok(root)
}

fn repository_context(
    workspace_root: &str,
    repository_root: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let workspace = canonical_workspace_root(workspace_root)?;
    let repository_root = repository_root.trim();
    if repository_root.is_empty() {
        return Err("Select a Git repository first.".to_string());
    }
    let repository = fs::canonicalize(repository_root)
        .map_err(|error| format!("Repository {repository_root} is unavailable: {error}"))?;
    if !repository.is_dir() {
        return Err("The selected Git repository is not a directory.".to_string());
    }
    if !repository.starts_with(&workspace) {
        return Err("The selected Git repository is outside this workspace.".to_string());
    }
    let arguments = ["rev-parse", "--show-toplevel"];
    let output = command_output("git", &arguments, &repository)
        .map_err(|error| format!("Git is unavailable. {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if detail.contains("not a git repository") {
            return Err("The selected folder is not a Git repository.".to_string());
        }
        return Err(output_error("git", &arguments, &output));
    }
    let repository_text = output_text(&output);
    let detected_repository = fs::canonicalize(repository_text.trim()).map_err(|error| {
        format!("The detected Git repository root could not be resolved: {error}")
    })?;
    if detected_repository != repository {
        return Err("The selected folder is not a Git repository root.".to_string());
    }
    Ok((workspace, repository))
}

fn relative_workspace_path(workspace: &Path, repository: &Path) -> String {
    let Ok(relative) = repository.strip_prefix(workspace) else {
        return repository.display().to_string();
    };
    if relative.as_os_str().is_empty() {
        return ".".to_string();
    }
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn push_discovery_issue(issues: &mut Vec<String>, issue: String) {
    if issues.len() < MAX_REPOSITORY_SCAN_ISSUES && !issues.contains(&issue) {
        issues.push(issue);
    }
}

fn repository_scan_directory_is_ignored(name: &std::ffi::OsStr) -> bool {
    #[cfg(target_os = "windows")]
    let ignored = REPOSITORY_SCAN_IGNORED_DIRECTORIES
        .iter()
        .any(|ignored| name.to_string_lossy().eq_ignore_ascii_case(ignored));
    #[cfg(not(target_os = "windows"))]
    let ignored = REPOSITORY_SCAN_IGNORED_DIRECTORIES
        .iter()
        .any(|ignored| name == std::ffi::OsStr::new(ignored));
    ignored
}

fn scan_repository_candidates(workspace: &Path) -> (Vec<PathBuf>, bool, Vec<String>) {
    let mut pending = VecDeque::from([workspace.to_path_buf()]);
    let mut candidates = Vec::new();
    let mut issues = Vec::new();
    let mut directories_scanned = 0usize;
    let mut scan_limited = false;

    'scan: while let Some(directory) = pending.pop_front() {
        if directories_scanned >= MAX_REPOSITORY_SCAN_DIRECTORIES {
            scan_limited = true;
            break;
        }
        directories_scanned += 1;
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                push_discovery_issue(
                    &mut issues,
                    format!(
                        "Could not scan {}: {error}",
                        relative_workspace_path(workspace, &directory)
                    ),
                );
                continue;
            }
        };
        let mut has_git_marker = false;
        let mut child_directories = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    push_discovery_issue(
                        &mut issues,
                        format!(
                            "Could not scan {}: {error}",
                            relative_workspace_path(workspace, &directory)
                        ),
                    );
                    continue;
                }
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    push_discovery_issue(
                        &mut issues,
                        format!(
                            "Could not inspect {}: {error}",
                            relative_workspace_path(workspace, &entry.path())
                        ),
                    );
                    continue;
                }
            };
            if entry.file_name() == ".git" {
                has_git_marker =
                    file_type.is_dir() || file_type.is_file() || file_type.is_symlink();
                continue;
            }
            if file_type.is_dir()
                && !file_type.is_symlink()
                && !repository_scan_directory_is_ignored(&entry.file_name())
            {
                if directories_scanned + pending.len() + child_directories.len()
                    < MAX_REPOSITORY_SCAN_DIRECTORIES
                {
                    child_directories.push(entry.path());
                } else {
                    scan_limited = true;
                }
            }
        }
        if has_git_marker {
            if candidates.len() >= MAX_DISCOVERED_REPOSITORIES {
                scan_limited = true;
                break 'scan;
            }
            candidates.push(directory);
        }
        child_directories.sort();
        for child in child_directories {
            if directories_scanned + pending.len() >= MAX_REPOSITORY_SCAN_DIRECTORIES {
                scan_limited = true;
                break;
            }
            pending.push_back(child);
        }
    }
    (candidates, scan_limited, issues)
}

fn inspect_repository_candidate(
    workspace: &Path,
    candidate: &Path,
) -> Result<Option<PathBuf>, String> {
    let candidate = fs::canonicalize(candidate)
        .map_err(|error| format!("Repository {} is unavailable: {error}", candidate.display()))?;
    let arguments = ["rev-parse", "--show-toplevel"];
    let output = command_output("git", &arguments, &candidate)
        .map_err(|error| format!("Git is unavailable. {error}"))?;
    if !output.status.success() {
        return Err(output_error("git", &arguments, &output));
    }
    let repository = fs::canonicalize(output_text(&output)).map_err(|error| {
        format!("The detected Git repository root could not be resolved: {error}")
    })?;
    if repository != candidate || !repository.starts_with(workspace) {
        return Ok(None);
    }
    Ok(Some(repository))
}

fn discover_repositories(workspace_root: &str) -> Result<WorkspaceGitRepositoryDiscovery, String> {
    let workspace = canonical_workspace_root(workspace_root)?;
    let (candidates, scan_limited, mut issues) = scan_repository_candidates(&workspace);
    let mut roots = HashSet::new();
    let mut repositories = Vec::new();
    for candidate in candidates {
        match inspect_repository_candidate(&workspace, &candidate) {
            Ok(Some(repository)) if roots.insert(repository.clone()) => {
                repositories.push(WorkspaceGitRepository {
                    repository_root: repository.display().to_string(),
                    relative_path: relative_workspace_path(&workspace, &repository),
                });
            }
            Ok(_) => {}
            Err(error) => push_discovery_issue(
                &mut issues,
                format!(
                    "Could not inspect {}: {error}",
                    relative_workspace_path(&workspace, &candidate)
                ),
            ),
        }
    }
    repositories.sort_by(|left, right| {
        match (left.relative_path.as_str(), right.relative_path.as_str()) {
            (".", ".") => std::cmp::Ordering::Equal,
            (".", _) => std::cmp::Ordering::Less,
            (_, ".") => std::cmp::Ordering::Greater,
            (left, right) => left.to_lowercase().cmp(&right.to_lowercase()),
        }
    });
    Ok(WorkspaceGitRepositoryDiscovery {
        workspace_root: workspace.display().to_string(),
        repositories,
        scan_limited,
        issues,
    })
}

fn status_is_conflicted(left: char, right: char) -> bool {
    matches!((left, right), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'))
}

type StatusSummary = (
    Vec<WorkspaceGitChange>,
    bool,
    usize,
    usize,
    usize,
    usize,
    usize,
);

fn parse_status(output: &str) -> StatusSummary {
    parse_status_matching(output, None)
}

fn parse_status_matching(output: &str, selected_path: Option<&str>) -> StatusSummary {
    let mut changes = Vec::new();
    let mut total = 0usize;
    let mut staged = 0usize;
    let mut unstaged = 0usize;
    let mut untracked = 0usize;
    let mut conflicted = 0usize;
    let mut records = output.split_terminator('\0');
    while let Some(record) = records.next() {
        if record.len() < 3 {
            continue;
        }
        total += 1;
        let bytes = record.as_bytes();
        let left = bytes.first().copied().unwrap_or(b' ') as char;
        let right = bytes.get(1).copied().unwrap_or(b' ') as char;
        let is_untracked = left == '?' && right == '?';
        let is_conflicted = status_is_conflicted(left, right);
        let is_staged = !is_untracked && !matches!(left, ' ' | '.' | '?' | '!');
        let is_unstaged = !is_untracked && !matches!(right, ' ' | '.' | '?' | '!');
        if is_untracked {
            untracked += 1;
        } else {
            if is_conflicted {
                conflicted += 1;
            }
            if is_staged {
                staged += 1;
            }
            if is_unstaged {
                unstaged += 1;
            }
        }
        let original_path = (matches!(left, 'R' | 'C') || matches!(right, 'R' | 'C'))
            .then(|| records.next())
            .flatten();
        if changes.len() < MAX_GIT_ENTRIES
            && selected_path.is_none_or(|path| record.get(3..) == Some(path))
        {
            changes.push(WorkspaceGitChange {
                status: format!("{left}{right}"),
                path: record.get(3..).unwrap_or_default().to_string(),
                original_path: original_path.map(ToOwned::to_owned),
                staged: is_staged,
                unstaged: is_unstaged,
                untracked: is_untracked,
                conflicted: is_conflicted,
            });
        }
    }
    (
        changes,
        total > MAX_GIT_ENTRIES,
        staged,
        unstaged,
        untracked,
        conflicted,
        total,
    )
}

fn status_output(repository: &Path) -> Result<String, String> {
    read_status(repository, None, true)
}

fn read_status(repository: &Path, path: Option<&str>, untracked: bool) -> Result<String, String> {
    let mut arguments = vec![
        "status",
        "--porcelain=v1",
        "-z",
        if untracked {
            "--untracked-files=all"
        } else {
            "--untracked-files=no"
        },
    ];
    if let Some(path) = path {
        arguments.extend(["--", path]);
    }
    let output = command_output("git", &arguments, repository)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(output_error("git", &arguments, &output))
    }
}

fn truncate_diff_output(bytes: &[u8]) -> (String, bool) {
    let truncated = bytes.len() > MAX_GIT_DIFF_BYTES;
    let bounded = &bytes[..bytes.len().min(MAX_GIT_DIFF_BYTES)];
    let content = String::from_utf8_lossy(bounded)
        .trim_end_matches(['\r', '\n'])
        .to_string();
    (content, truncated)
}

fn run_diff(
    repository: &Path,
    kind: &str,
    arguments: &[&str],
    allow_difference_exit: bool,
) -> Result<WorkspaceGitPatch, String> {
    let output = command_output_bounded("git", arguments, repository, MAX_GIT_DIFF_BYTES + 1)?;
    if !output.status.success() && !(allow_difference_exit && output.status.code() == Some(1)) {
        return Err(output_error("git", arguments, &output));
    }
    let (content, truncated) = truncate_diff_output(&output.stdout);
    let binary = content.contains("Binary files ") || content.contains("GIT binary patch");
    Ok(WorkspaceGitPatch {
        kind: kind.to_string(),
        content,
        binary,
        truncated,
    })
}

fn load_diff(request: WorkspaceGitDiffRequest) -> Result<WorkspaceGitDiff, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    if request.relative_path.is_empty() || request.relative_path.contains('\0') {
        return Err("Select a changed file to view its diff.".to_string());
    }
    let (changes, _, _, _, _, _, _) = parse_status_matching(
        &read_status(&repository, Some(&request.relative_path), true)?,
        Some(&request.relative_path),
    );
    let mut change = changes
        .into_iter()
        .find(|change| change.path == request.relative_path)
        .ok_or_else(|| "This file is no longer changed.".to_string())?;
    // A path-limited status represents a staged rename as an addition because
    // its source was excluded. Only these additions need the wider tracked scan.
    if change.status.starts_with('A') {
        if let Some(renamed) = parse_status_matching(
            &read_status(&repository, None, false)?,
            Some(&request.relative_path),
        )
        .0
        .into_iter()
        .next()
        {
            change = renamed;
        }
    }
    let mut patches = Vec::new();
    if change.staged {
        patches.push(run_diff(
            &repository,
            "staged",
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--find-renames",
                "--unified=3",
                "--",
                &change.path,
            ],
            false,
        )?);
    }
    if change.unstaged || change.conflicted {
        patches.push(run_diff(
            &repository,
            "unstaged",
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--find-renames",
                "--unified=3",
                "--",
                &change.path,
            ],
            false,
        )?);
    }
    if change.untracked {
        patches.push(run_diff(
            &repository,
            "untracked",
            &[
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--unified=3",
                "--",
                "/dev/null",
                &change.path,
            ],
            true,
        )?);
    }
    Ok(WorkspaceGitDiff {
        path: change.path,
        original_path: change.original_path,
        patches,
    })
}

fn parse_branches(output: &str, remote: bool) -> Vec<WorkspaceGitBranch> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let mut name = parts.next()?.trim().to_string();
            if remote && name.ends_with("/HEAD") {
                return None;
            }
            if remote {
                name = name.trim_start_matches("refs/remotes/").to_string();
            }
            let commit = parts.next().unwrap_or_default().trim().to_string();
            let upstream = parts.next().unwrap_or_default().trim();
            let marker = parts.next().unwrap_or_default().trim();
            if let Some(reference) = parts.next() {
                if reference.starts_with("refs/remotes/") != remote {
                    return None;
                }
            }
            Some(WorkspaceGitBranch {
                name,
                commit,
                current: marker == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            })
        })
        .collect()
}

fn parse_remotes(output: &str) -> Vec<WorkspaceGitRemote> {
    let mut values: BTreeMap<String, (Option<String>, Option<String>)> = BTreeMap::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(url) = parts.next() else { continue };
        let direction = parts.next().unwrap_or_default();
        let entry = values.entry(name.to_string()).or_default();
        if direction == "(fetch)" {
            entry.0 = Some(url.to_string());
        } else if direction == "(push)" {
            entry.1 = Some(url.to_string());
        }
    }
    values
        .into_iter()
        .map(|(name, (fetch_url, push_url))| WorkspaceGitRemote {
            name,
            fetch_url,
            push_url,
        })
        .collect()
}

fn parse_head_commit(output: &str) -> Option<WorkspaceGitCommit> {
    let mut parts = output.split('\u{1f}');
    Some(WorkspaceGitCommit {
        hash: parts.next()?.to_string(),
        short_hash: parts.next()?.to_string(),
        subject: parts.next()?.to_string(),
        author: parts.next()?.to_string(),
        authored_at: parts.next()?.to_string(),
    })
}

fn pull_request_overview(repository: &Path, has_remote: bool) -> WorkspacePullRequestOverview {
    if !has_remote {
        return WorkspacePullRequestOverview {
            available: false,
            reason: Some("Add a Git remote to load pull requests.".to_string()),
            items: Vec::new(),
        };
    }
    let args = [
        "pr",
        "list",
        "--limit",
        "50",
        "--json",
        "number,title,state,url,headRefName,baseRefName,isDraft,author,updatedAt",
    ];
    let output = match command_output("gh", &args, repository) {
        Ok(output) if output.status.success() => output_text(&output),
        Ok(output) => {
            return WorkspacePullRequestOverview {
                available: false,
                reason: Some(output_error("gh", &args, &output)),
                items: Vec::new(),
            }
        }
        Err(error) => {
            return WorkspacePullRequestOverview {
                available: false,
                reason: Some(error),
                items: Vec::new(),
            }
        }
    };
    let values = match serde_json::from_str::<Vec<Value>>(&output) {
        Ok(values) => values,
        Err(error) => {
            return WorkspacePullRequestOverview {
                available: false,
                reason: Some(format!(
                    "GitHub CLI returned invalid pull-request data: {error}"
                )),
                items: Vec::new(),
            }
        }
    };
    let items = values
        .into_iter()
        .filter_map(|value| {
            Some(WorkspacePullRequest {
                number: value.get("number")?.as_u64()?,
                title: value.get("title")?.as_str()?.to_string(),
                state: value.get("state")?.as_str()?.to_string(),
                url: value.get("url")?.as_str()?.to_string(),
                head_branch: value.get("headRefName")?.as_str()?.to_string(),
                base_branch: value.get("baseRefName")?.as_str()?.to_string(),
                draft: value
                    .get("isDraft")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                author: value
                    .get("author")
                    .and_then(|author| author.get("login"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                updated_at: value
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();
    WorkspacePullRequestOverview {
        available: true,
        reason: None,
        items,
    }
}

fn load_overview(
    workspace_root: &str,
    repository_root: &str,
) -> Result<WorkspaceGitOverview, String> {
    let (workspace, repository) = repository_context(workspace_root, repository_root)?;
    let status_output = status_output(&repository)?;
    let (
        changes,
        changes_truncated,
        staged_count,
        unstaged_count,
        untracked_count,
        conflicted_count,
        total_changes,
    ) = parse_status(&status_output);
    let branch = run_optional(
        "git",
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        &repository,
    )
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "Detached HEAD".to_string());
    let detached = branch == "Detached HEAD";
    let upstream = run_optional(
        "git",
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        &repository,
    )
    .filter(|value| !value.is_empty());
    let (ahead, behind) = upstream
        .as_ref()
        .and_then(|_| {
            run_optional(
                "git",
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
                &repository,
            )
        })
        .and_then(|value| {
            let mut parts = value.split_whitespace();
            Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
        })
        .unwrap_or((0, 0));
    let branch_output = run_required(
            "git",
            &[
                "for-each-ref",
                "--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)%09%(refname)",
                "refs/heads",
                "refs/remotes",
            ],
            &repository,
        )?;
    let mut local_branches = parse_branches(&branch_output, false);
    if !detached
        && !local_branches
            .iter()
            .any(|candidate| candidate.name == branch)
    {
        local_branches.insert(
            0,
            WorkspaceGitBranch {
                name: branch.clone(),
                commit: "unborn".to_string(),
                current: true,
                upstream: upstream.clone(),
            },
        );
    }
    let remote_branches = parse_branches(&branch_output, true);
    let remotes = parse_remotes(&run_required("git", &["remote", "-v"], &repository)?);
    let head_commit = run_optional(
        "git",
        &["log", "-1", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI"],
        &repository,
    )
    .and_then(|value| parse_head_commit(&value));
    Ok(WorkspaceGitOverview {
        workspace_root: workspace.display().to_string(),
        repository_root: repository.display().to_string(),
        branch,
        detached,
        upstream,
        ahead,
        behind,
        clean: changes.is_empty(),
        staged_count,
        unstaged_count,
        untracked_count,
        conflicted_count,
        total_changes,
        changes,
        changes_truncated,
        local_branches,
        remote_branches,
        remotes,
        head_commit,
    })
}

fn validate_branch_name(branch_name: Option<&str>, repository: &Path) -> Result<String, String> {
    let name = branch_name.unwrap_or_default().trim();
    if name.is_empty() || name.chars().count() > 255 || name.chars().any(char::is_control) {
        return Err("Enter a valid branch name.".to_string());
    }
    run_required("git", &["check-ref-format", "--branch", name], repository)
        .map_err(|_| "Enter a valid branch name.".to_string())?;
    Ok(name.to_string())
}

fn validate_remote_name(remote_name: Option<&str>) -> Result<String, String> {
    let name = remote_name.unwrap_or_default().trim();
    if name.is_empty()
        || name.chars().count() > 100
        || name.starts_with('-')
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("Enter a valid remote name.".to_string());
    }
    Ok(name.to_string())
}

fn validate_remote_url(remote_url: Option<&str>) -> Result<String, String> {
    let url = remote_url.unwrap_or_default().trim();
    if url.is_empty()
        || url.starts_with('-')
        || url.chars().count() > 2_000
        || url.chars().any(char::is_control)
    {
        return Err("Enter a valid remote URL.".to_string());
    }
    Ok(url.to_string())
}

#[tauri::command]
pub async fn discover_workspace_git_repositories(
    workspace_root: String,
) -> Result<WorkspaceGitRepositoryDiscovery, String> {
    run_git_read(move || discover_repositories(&workspace_root)).await
}

#[tauri::command]
pub async fn get_workspace_git_overview(
    request: WorkspaceGitRepositoryRequest,
) -> Result<WorkspaceGitOverview, String> {
    run_git_read(move || load_overview(&request.workspace_root, &request.repository_root)).await
}

#[tauri::command]
pub async fn get_workspace_git_diff(
    request: WorkspaceGitDiffRequest,
) -> Result<WorkspaceGitDiff, String> {
    run_git_read(move || load_diff(request)).await
}

#[tauri::command]
pub async fn get_workspace_pull_requests(
    request: WorkspaceGitRepositoryRequest,
) -> Result<WorkspacePullRequestOverview, String> {
    run_git_read(move || {
        let (_, repository) =
            repository_context(&request.workspace_root, &request.repository_root)?;
        let has_remote = !run_required("git", &["remote"], &repository)?.is_empty();
        Ok(pull_request_overview(&repository, has_remote))
    })
    .await
}

fn execute_workspace_git_action(
    request: WorkspaceGitActionRequest,
) -> Result<WorkspaceGitOverview, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    match request.action.as_str() {
        "fetch" => {
            run_required("git", &["fetch", "--all", "--prune"], &repository)?;
        }
        "pull" => {
            run_required("git", &["pull", "--ff-only"], &repository)?;
        }
        "checkout" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), &repository)?;
            run_required("git", &["switch", &branch], &repository)?;
        }
        "checkout-remote" => {
            let branch = request.branch_name.as_deref().unwrap_or_default().trim();
            if branch.is_empty() || branch.starts_with('-') {
                return Err("Select a valid remote branch.".to_string());
            }
            run_required(
                "git",
                &["check-ref-format", &format!("refs/remotes/{branch}")],
                &repository,
            )
            .map_err(|_| "Select a valid remote branch.".to_string())?;
            run_required("git", &["switch", "--track", branch], &repository)?;
        }
        "create-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), &repository)?;
            run_required("git", &["switch", "-c", &branch], &repository)?;
        }
        "add-remote" => {
            let name = validate_remote_name(request.remote_name.as_deref())?;
            let url = validate_remote_url(request.remote_url.as_deref())?;
            run_required("git", &["remote", "add", &name, &url], &repository)?;
        }
        "remove-remote" => {
            let name = validate_remote_name(request.remote_name.as_deref())?;
            run_required("git", &["remote", "remove", &name], &repository)?;
        }
        _ => return Err("Unsupported workspace Git action.".to_string()),
    }
    load_overview(&request.workspace_root, &request.repository_root)
}

#[tauri::command]
pub async fn run_workspace_git_action(
    request: WorkspaceGitActionRequest,
) -> Result<WorkspaceGitOverview, String> {
    tauri::async_runtime::spawn_blocking(move || execute_workspace_git_action(request))
        .await
        .map_err(|error| format!("The workspace Git action stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::{env, fs, time::SystemTime};

    use super::{
        command_output, discover_repositories, execute_workspace_git_action, load_diff,
        load_overview, parse_branches, parse_remotes, parse_status, repository_context,
        run_required, validate_remote_url, WorkspaceGitActionRequest, WorkspaceGitDiffRequest,
        MAX_GIT_DIFF_BYTES, MAX_GIT_ENTRIES,
    };

    #[test]
    fn status_parser_counts_real_porcelain_states() {
        let (changes, truncated, staged, unstaged, untracked, conflicted, total) = parse_status(
            " M changed.ts\0M  staged.ts\0?? new.ts\0UU conflict.ts\0R  renamed.ts\0old.ts\0 R worktree-renamed.ts\0worktree-old.ts\0",
        );
        assert_eq!(changes.len(), 6);
        assert!(!truncated);
        assert_eq!(
            (staged, unstaged, untracked, conflicted, total),
            (3, 3, 1, 1, 6)
        );
        assert_eq!(changes[0].path, "changed.ts");
        assert_eq!(changes[4].path, "renamed.ts");
        assert_eq!(changes[4].original_path.as_deref(), Some("old.ts"));
        assert_eq!(changes[5].path, "worktree-renamed.ts");
        assert_eq!(changes[5].original_path.as_deref(), Some("worktree-old.ts"));
    }

    #[test]
    fn discovers_deep_repositories_submodules_and_gitfile_worktrees() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-workspace-git-discovery-{}-{unique}",
            std::process::id()
        ));
        let main = root.join("main");
        let nested = main.join("vendor").join("child");
        let api = root.join("products").join("platform").join("api");
        let linked = root.join("linked");
        let submodule_origin = env::temp_dir().join(format!(
            "machdoch-workspace-git-submodule-origin-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&main).expect("the main repository should be created");
        fs::create_dir_all(&api).expect("the deep repository should be created");
        run_required("git", &["init"], &main).expect("main git init should succeed");
        run_required("git", &["init"], &api).expect("api git init should succeed");
        fs::create_dir_all(&submodule_origin).expect("submodule origin should be created");
        run_required("git", &["init"], &submodule_origin)
            .expect("submodule origin git init should succeed");
        run_required(
            "git",
            &["config", "user.email", "discovery@example.test"],
            &main,
        )
        .expect("Git email should configure");
        run_required("git", &["config", "user.name", "Discovery"], &main)
            .expect("Git name should configure");
        run_required(
            "git",
            &["config", "user.email", "submodule@example.test"],
            &submodule_origin,
        )
        .expect("submodule Git email should configure");
        run_required(
            "git",
            &["config", "user.name", "Submodule"],
            &submodule_origin,
        )
        .expect("submodule Git name should configure");
        fs::write(main.join("tracked.txt"), "main\n").expect("tracked file should write");
        run_required("git", &["add", "."], &main).expect("tracked file should stage");
        run_required("git", &["commit", "-m", "initial"], &main)
            .expect("initial commit should succeed");
        fs::write(submodule_origin.join("module.txt"), "module\n")
            .expect("submodule fixture should write");
        run_required("git", &["add", "."], &submodule_origin)
            .expect("submodule fixture should stage");
        run_required(
            "git",
            &["commit", "-m", "submodule initial"],
            &submodule_origin,
        )
        .expect("submodule initial commit should succeed");
        run_required(
            "git",
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                submodule_origin.to_string_lossy().as_ref(),
                "components/module",
            ],
            &main,
        )
        .expect("submodule checkout should be created");
        assert!(main.join("components/module/.git").is_file());
        run_required(
            "git",
            &[
                "worktree",
                "add",
                "-b",
                "linked-discovery",
                linked.to_string_lossy().as_ref(),
            ],
            &main,
        )
        .expect("linked worktree should be created");
        assert!(linked.join(".git").is_file());
        fs::create_dir_all(&nested).expect("nested repository should be created");
        run_required("git", &["init"], &nested).expect("nested git init should succeed");

        let discovery = discover_repositories(root.to_string_lossy().as_ref())
            .expect("repository discovery should succeed");
        assert_eq!(
            discovery
                .repositories
                .iter()
                .map(|repository| repository.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "linked",
                "main",
                "main/components/module",
                "main/vendor/child",
                "products/platform/api"
            ]
        );
        assert!(!discovery.scan_limited);
        assert!(discovery.issues.is_empty());

        fs::write(api.join("api.txt"), "untracked\n").expect("api fixture should write");
        let api_overview = load_overview(
            root.to_string_lossy().as_ref(),
            api.to_string_lossy().as_ref(),
        )
        .expect("the deep repository should be targetable");
        assert_eq!(api_overview.untracked_count, 1);
        assert_eq!(
            api_overview.repository_root,
            fs::canonicalize(&api).unwrap().display().to_string()
        );

        let repository_subdirectory = main.join("src");
        fs::create_dir_all(&repository_subdirectory).expect("repository subfolder should exist");
        assert_eq!(
            repository_context(
                root.to_string_lossy().as_ref(),
                repository_subdirectory.to_string_lossy().as_ref(),
            )
            .expect_err("a repository subfolder must not be accepted as its identity"),
            "The selected folder is not a Git repository root."
        );
        let outside = env::temp_dir().join(format!(
            "machdoch-workspace-git-outside-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&outside).expect("outside repository should be created");
        run_required("git", &["init"], &outside).expect("outside git init should succeed");
        assert_eq!(
            repository_context(
                root.to_string_lossy().as_ref(),
                outside.to_string_lossy().as_ref(),
            )
            .expect_err("an outside repository must not be accepted"),
            "The selected Git repository is outside this workspace."
        );

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
        let _ = fs::remove_dir_all(submodule_origin);
    }

    #[test]
    fn discovery_preserves_a_root_repository_and_continues_after_invalid_markers() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-workspace-git-root-discovery-{}-{unique}",
            std::process::id()
        ));
        let nested = root.join("apps").join("api");
        let invalid = root.join("broken");
        let ignored_dependency = root.join("node_modules").join("dependency");
        fs::create_dir_all(&nested).expect("the nested repository should be created");
        fs::create_dir_all(&invalid).expect("the invalid candidate should be created");
        fs::create_dir_all(&ignored_dependency)
            .expect("the ignored dependency repository should be created");
        run_required("git", &["init"], &root).expect("root git init should succeed");
        run_required("git", &["init"], &nested).expect("nested git init should succeed");
        run_required("git", &["init"], &ignored_dependency)
            .expect("dependency git init should succeed");
        fs::write(invalid.join(".git"), "not a gitdir\n").expect("the invalid marker should write");

        let discovery = discover_repositories(root.to_string_lossy().as_ref())
            .expect("repository discovery should preserve valid repositories");
        assert_eq!(
            discovery
                .repositories
                .iter()
                .map(|repository| repository.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec![".", "apps/api"]
        );
        assert!(!discovery.scan_limited);
        assert!(discovery
            .issues
            .iter()
            .any(|issue| issue.contains("broken")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sibling_repository_state_diffs_and_actions_are_scoped_to_the_selected_root() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let workspace = env::temp_dir().join(format!(
            "machdoch-workspace-git-scope-{}-{unique}",
            std::process::id()
        ));
        let alpha = workspace.join("alpha");
        let beta = workspace.join("beta");
        fs::create_dir_all(&alpha).expect("the alpha repository should be created");
        fs::create_dir_all(&beta).expect("the beta repository should be created");
        run_required("git", &["init"], &alpha).expect("alpha git init should succeed");
        run_required("git", &["init"], &beta).expect("beta git init should succeed");
        fs::write(alpha.join("alpha-only.txt"), "alpha repository\n")
            .expect("the alpha fixture should write");
        fs::write(beta.join("beta-only.txt"), "beta repository\n")
            .expect("the beta fixture should write");

        let workspace_root = workspace.display().to_string();
        let alpha_root = alpha.display().to_string();
        let beta_root = beta.display().to_string();
        let alpha_branch_before = run_required("git", &["symbolic-ref", "--short", "HEAD"], &alpha)
            .expect("the alpha branch should resolve");
        let alpha_overview =
            load_overview(&workspace_root, &alpha_root).expect("the alpha overview should load");
        let beta_overview =
            load_overview(&workspace_root, &beta_root).expect("the beta overview should load");
        assert_eq!(
            alpha_overview
                .changes
                .iter()
                .map(|change| change.path.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha-only.txt"]
        );
        assert_eq!(
            beta_overview
                .changes
                .iter()
                .map(|change| change.path.as_str())
                .collect::<Vec<_>>(),
            vec!["beta-only.txt"]
        );

        let beta_diff = load_diff(WorkspaceGitDiffRequest {
            workspace_root: workspace_root.clone(),
            repository_root: beta_root.clone(),
            relative_path: "beta-only.txt".to_string(),
        })
        .expect("the beta diff should load");
        assert!(beta_diff.patches[0].content.contains("beta repository"));
        assert!(!beta_diff.patches[0].content.contains("alpha repository"));

        let action_overview = execute_workspace_git_action(WorkspaceGitActionRequest {
            workspace_root: workspace_root.clone(),
            repository_root: beta_root,
            action: "create-branch".to_string(),
            branch_name: Some("feature/beta-only".to_string()),
            remote_name: None,
            remote_url: None,
        })
        .expect("the beta branch action should succeed");
        assert_eq!(action_overview.branch, "feature/beta-only");
        assert_eq!(
            run_required("git", &["symbolic-ref", "--short", "HEAD"], &alpha)
                .expect("the alpha branch should remain readable"),
            alpha_branch_before
        );
        assert_eq!(
            run_required("git", &["symbolic-ref", "--short", "HEAD"], &beta)
                .expect("the beta branch should update"),
            "feature/beta-only"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn diff_reader_handles_staged_unstaged_untracked_renamed_and_binary_changes() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-workspace-git-diff-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("the test repository should be created");
        run_required("git", &["init"], &root).expect("git init should succeed");
        run_required(
            "git",
            &["config", "user.email", "audit@example.test"],
            &root,
        )
        .expect("Git email should configure");
        run_required("git", &["config", "user.name", "Audit"], &root)
            .expect("Git name should configure");
        fs::write(root.join("tracked.txt"), "before\n").expect("tracked file should write");
        fs::write(root.join("old.txt"), "rename\n").expect("rename fixture should write");
        fs::write(root.join("deleted.txt"), "delete\n").expect("delete fixture should write");
        fs::write(root.join("binary.dat"), [0_u8, 1, 2]).expect("binary fixture should write");
        run_required("git", &["add", "."], &root).expect("fixtures should stage");
        run_required("git", &["commit", "-m", "fixtures"], &root).expect("commit should succeed");

        fs::write(root.join("tracked.txt"), "staged\n").expect("staged file should write");
        run_required("git", &["add", "tracked.txt"], &root).expect("change should stage");
        fs::write(root.join("tracked.txt"), "staged\nunstaged\n")
            .expect("unstaged file should write");
        run_required("git", &["mv", "old.txt", "renamed.txt"], &root).expect("rename should stage");
        fs::write(root.join("new.txt"), "untracked\n").expect("untracked file should write");
        fs::write(root.join("binary.dat"), [0_u8, 9, 2]).expect("binary change should write");
        fs::remove_file(root.join("deleted.txt")).expect("deleted fixture should remove");

        let tracked = load_diff(WorkspaceGitDiffRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            relative_path: "tracked.txt".to_string(),
        })
        .expect("tracked diff should load");
        assert_eq!(tracked.patches.len(), 2);
        assert!(tracked.patches.iter().any(|patch| patch.kind == "staged"));
        assert!(tracked.patches.iter().any(|patch| patch.kind == "unstaged"));

        let renamed = load_diff(WorkspaceGitDiffRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            relative_path: "renamed.txt".to_string(),
        })
        .expect("renamed diff should load");
        assert_eq!(renamed.original_path.as_deref(), Some("old.txt"));

        let untracked = load_diff(WorkspaceGitDiffRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            relative_path: "new.txt".to_string(),
        })
        .expect("untracked diff should load");
        assert!(untracked.patches[0].content.contains("untracked"));

        let binary = load_diff(WorkspaceGitDiffRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            relative_path: "binary.dat".to_string(),
        })
        .expect("binary diff should load");
        assert!(binary.patches[0].binary);

        let deleted = load_diff(WorkspaceGitDiffRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            relative_path: "deleted.txt".to_string(),
        })
        .expect("deleted diff should load");
        assert!(deleted.patches[0].content.contains("deleted file mode"));

        fs::write(
            root.join("large.txt"),
            "a large untracked line\n".repeat(MAX_GIT_DIFF_BYTES / 8),
        )
        .expect("large fixture should write");
        let large = load_diff(WorkspaceGitDiffRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            relative_path: "large.txt".to_string(),
        })
        .expect("large diff should load");
        assert!(large.patches[0].truncated);
        assert!(large.patches[0].content.len() <= MAX_GIT_DIFF_BYTES);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn diff_reader_selects_literal_paths_beyond_the_overview_limit() {
        let root = env::temp_dir().join(format!(
            "machdoch-git-literal-diff-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        run_required("git", &["init"], &root).unwrap();
        for index in 0..=MAX_GIT_ENTRIES {
            fs::write(root.join(format!("a-{index:04}.txt")), "filler\n").unwrap();
        }
        fs::write(root.join("z[1].txt"), "selected literal file\n").unwrap();
        fs::write(root.join("z1.txt"), "unrelated pattern match\n").unwrap();
        let diff = load_diff(WorkspaceGitDiffRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            relative_path: "z[1].txt".to_string(),
        })
        .unwrap();
        assert_eq!(diff.patches.len(), 1);
        assert!(diff.patches[0].content.contains("selected literal file"));
        assert!(!diff.patches[0].content.contains("unrelated pattern match"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn combined_branch_output_keeps_local_and_remote_refs_separate() {
        let output = "main\tabc\torigin/main\t*\trefs/heads/main\norigin/main\tabc\t\t \trefs/remotes/origin/main\norigin/HEAD\tabc\t\t \trefs/remotes/origin/HEAD\n";
        let local = parse_branches(output, false);
        let remote = parse_branches(output, true);
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].name, "main");
        assert!(local[0].current);
        assert_eq!(remote.len(), 1);
        assert_eq!(remote[0].name, "origin/main");
    }

    #[test]
    fn diff_reader_handles_conflicts_and_non_repositories() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-workspace-git-conflict-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("the test repository should be created");
        assert_eq!(
            repository_context(
                root.to_string_lossy().as_ref(),
                root.to_string_lossy().as_ref(),
            )
            .expect_err("a plain directory should not be a repository"),
            "The selected folder is not a Git repository."
        );
        run_required("git", &["init"], &root).expect("git init should succeed");
        run_required(
            "git",
            &["config", "user.email", "audit@example.test"],
            &root,
        )
        .expect("Git email should configure");
        run_required("git", &["config", "user.name", "Audit"], &root)
            .expect("Git name should configure");
        fs::write(root.join("conflict.txt"), "base\n").expect("base file should write");
        run_required("git", &["add", "."], &root).expect("base file should stage");
        run_required("git", &["commit", "-m", "base"], &root).expect("base should commit");
        run_required("git", &["switch", "-c", "conflict-side"], &root)
            .expect("side branch should create");
        fs::write(root.join("conflict.txt"), "side\n").expect("side file should write");
        run_required("git", &["commit", "-am", "side"], &root).expect("side should commit");
        run_required("git", &["switch", "-"], &root).expect("base branch should restore");
        fs::write(root.join("conflict.txt"), "main\n").expect("main file should write");
        run_required("git", &["commit", "-am", "main"], &root).expect("main should commit");
        let merge = command_output("git", &["merge", "conflict-side"], &root)
            .expect("merge command should run");
        assert!(!merge.status.success());

        let conflict = load_diff(WorkspaceGitDiffRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            relative_path: "conflict.txt".to_string(),
        })
        .expect("conflict diff should load");
        assert!(!conflict.patches.is_empty());
        assert!(conflict
            .patches
            .iter()
            .any(|patch| !patch.content.is_empty()));
        assert!(validate_remote_url(Some("--upload-pack=unsafe")).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn branch_and_remote_parsers_preserve_repository_data() {
        let branches = parse_branches("main\tabc123\torigin/main\t*\nfeature\tdef456\t\t\n", false);
        assert_eq!(branches.len(), 2);
        assert!(branches[0].current);
        assert_eq!(branches[0].upstream.as_deref(), Some("origin/main"));
        let remotes = parse_remotes(
            "origin https://example.test/repo.git (fetch)\norigin ssh://example.test/repo.git (push)\n",
        );
        assert_eq!(remotes.len(), 1);
        assert_eq!(
            remotes[0].fetch_url.as_deref(),
            Some("https://example.test/repo.git")
        );
    }

    #[test]
    fn branch_actions_reflect_real_repository_state() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-workspace-git-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("the test repository should be created");
        run_required("git", &["init"], &root).expect("git init should succeed");

        let overview = execute_workspace_git_action(WorkspaceGitActionRequest {
            workspace_root: root.display().to_string(),
            repository_root: root.display().to_string(),
            action: "create-branch".to_string(),
            branch_name: Some("feature/workspace-ui".to_string()),
            remote_name: None,
            remote_url: None,
        })
        .expect("branch creation should succeed");

        assert_eq!(overview.branch, "feature/workspace-ui");
        assert!(overview
            .local_branches
            .iter()
            .any(|branch| branch.name == "feature/workspace-ui" && branch.current));

        fs::remove_dir_all(&root).expect("the test repository should be removed");
    }
}
