use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_GIT_ENTRIES: usize = 300;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitChange {
    status: String,
    path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBranch {
    name: String,
    commit: String,
    current: bool,
    upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitRemote {
    name: String,
    fetch_url: Option<String>,
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
    author: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePullRequestOverview {
    available: bool,
    reason: Option<String>,
    items: Vec<WorkspacePullRequest>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitOverview {
    workspace_root: String,
    repository_root: String,
    branch: String,
    detached: bool,
    upstream: Option<String>,
    ahead: u64,
    behind: u64,
    clean: bool,
    staged_count: usize,
    unstaged_count: usize,
    untracked_count: usize,
    conflicted_count: usize,
    changes: Vec<WorkspaceGitChange>,
    changes_truncated: bool,
    local_branches: Vec<WorkspaceGitBranch>,
    remote_branches: Vec<WorkspaceGitBranch>,
    remotes: Vec<WorkspaceGitRemote>,
    head_commit: Option<WorkspaceGitCommit>,
    pull_requests: WorkspacePullRequestOverview,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitActionRequest {
    workspace_root: String,
    action: String,
    branch_name: Option<String>,
    remote_name: Option<String>,
    remote_url: Option<String>,
}

fn command_output(program: &str, args: &[&str], cwd: &Path) -> Result<Output, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .map_err(|error| format!("Failed to run {program}: {error}"))
}

fn output_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn output_error(program: &str, args: &[&str], output: &Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        format!(
            "{program} {} exited with status {}.",
            args.join(" "),
            output.status
        )
    } else {
        format!("{program} {} failed: {detail}", args.join(" "))
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

fn repository_context(workspace_root: &str) -> Result<(PathBuf, PathBuf), String> {
    let workspace = canonical_workspace_root(workspace_root)?;
    let repository_text = run_required("git", &["rev-parse", "--show-toplevel"], &workspace)
        .map_err(|error| format!("Git is unavailable for this workspace. {error}"))?;
    let repository = fs::canonicalize(repository_text.trim()).map_err(|error| {
        format!("The detected Git repository root could not be resolved: {error}")
    })?;
    if !repository.starts_with(&workspace) {
        return Err(
            "The detected Git repository root is outside the configured workspace.".to_string(),
        );
    }
    Ok((workspace, repository))
}

fn parse_status(output: &str) -> (Vec<WorkspaceGitChange>, bool, usize, usize, usize, usize) {
    let mut changes = Vec::new();
    let mut total = 0usize;
    let mut staged = 0usize;
    let mut unstaged = 0usize;
    let mut untracked = 0usize;
    let mut conflicted = 0usize;
    for line in output.lines().filter(|line| !line.is_empty()) {
        if line.starts_with("## ") {
            continue;
        }
        total += 1;
        let bytes = line.as_bytes();
        let left = bytes.first().copied().unwrap_or(b' ') as char;
        let right = bytes.get(1).copied().unwrap_or(b' ') as char;
        if left == '?' && right == '?' {
            untracked += 1;
        } else {
            if matches!((left, right), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D')) {
                conflicted += 1;
            }
            if !matches!(left, ' ' | '.' | '?' | '!') {
                staged += 1;
            }
            if !matches!(right, ' ' | '.' | '?' | '!') {
                unstaged += 1;
            }
        }
        if changes.len() < MAX_GIT_ENTRIES {
            changes.push(WorkspaceGitChange {
                status: format!("{left}{right}"),
                path: line.get(3..).unwrap_or_default().to_string(),
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
    )
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

fn load_overview(workspace_root: &str) -> Result<WorkspaceGitOverview, String> {
    let (workspace, repository) = repository_context(workspace_root)?;
    let status_output = run_required(
        "git",
        &[
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=all",
        ],
        &repository,
    )?;
    let (
        changes,
        changes_truncated,
        staged_count,
        unstaged_count,
        untracked_count,
        conflicted_count,
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
    let mut local_branches = parse_branches(
        &run_required(
            "git",
            &[
                "for-each-ref",
                "--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)",
                "refs/heads",
            ],
            &repository,
        )?,
        false,
    );
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
    let remote_branches = parse_branches(
        &run_required(
            "git",
            &[
                "for-each-ref",
                "--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)",
                "refs/remotes",
            ],
            &repository,
        )?,
        true,
    );
    let remotes = parse_remotes(&run_required("git", &["remote", "-v"], &repository)?);
    let head_commit = run_optional(
        "git",
        &["log", "-1", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI"],
        &repository,
    )
    .and_then(|value| parse_head_commit(&value));
    let pull_requests = pull_request_overview(&repository, !remotes.is_empty());
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
        changes,
        changes_truncated,
        local_branches,
        remote_branches,
        remotes,
        head_commit,
        pull_requests,
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
    if url.is_empty() || url.chars().count() > 2_000 || url.chars().any(char::is_control) {
        return Err("Enter a valid remote URL.".to_string());
    }
    Ok(url.to_string())
}

#[tauri::command]
pub async fn get_workspace_git_overview(
    workspace_root: String,
) -> Result<WorkspaceGitOverview, String> {
    tauri::async_runtime::spawn_blocking(move || load_overview(&workspace_root))
        .await
        .map_err(|error| format!("The workspace Git reader stopped unexpectedly: {error}"))?
}

fn execute_workspace_git_action(
    request: WorkspaceGitActionRequest,
) -> Result<WorkspaceGitOverview, String> {
    let (_, repository) = repository_context(&request.workspace_root)?;
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
    load_overview(&request.workspace_root)
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
        execute_workspace_git_action, parse_branches, parse_remotes, parse_status, run_required,
        WorkspaceGitActionRequest,
    };

    #[test]
    fn status_parser_counts_real_porcelain_states() {
        let (changes, truncated, staged, unstaged, untracked, conflicted) = parse_status(
            "## main...origin/main [ahead 1]\nM  staged.ts\n M changed.ts\n?? new.ts\nUU conflict.ts\n",
        );
        assert_eq!(changes.len(), 4);
        assert!(!truncated);
        assert_eq!((staged, unstaged, untracked, conflicted), (2, 2, 1, 1));
        assert_eq!(changes[0].path, "staged.ts");
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
