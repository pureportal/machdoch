use std::path::Path;

use super::{
    command_output, current_operation, load_overview, output_error, repository_context,
    run_optional, run_required, stack, WorkspaceGitActionRequest, WorkspaceGitOverview,
    FETCH_ARGUMENTS,
};

const MAX_ACTION_PATHS: usize = 2_000;
const MAX_PATH_ARGUMENT_CHARS: usize = 8_000;
const MAX_COMMIT_MESSAGE_CHARS: usize = 20_000;
const MAX_STASH_MESSAGE_CHARS: usize = 500;

pub(super) fn validate_branch_name(
    branch_name: Option<&str>,
    repository: &Path,
) -> Result<String, String> {
    let name = branch_name.unwrap_or_default().trim();
    if name.is_empty() || name.chars().count() > 255 || name.chars().any(char::is_control) {
        return Err("Enter a valid branch name.".to_string());
    }
    run_required("git", &["check-ref-format", "--branch", name], repository)
        .map_err(|_| "Enter a valid branch name.".to_string())?;
    Ok(name.to_string())
}

pub(super) fn validate_revision(
    revision: Option<&str>,
    repository: &Path,
) -> Result<String, String> {
    let revision = revision.unwrap_or_default().trim();
    if revision.is_empty()
        || revision.starts_with('-')
        || revision.chars().count() > 255
        || revision.chars().any(char::is_control)
    {
        return Err("Select a valid branch.".to_string());
    }
    run_required(
        "git",
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{revision}^{{commit}}"),
        ],
        repository,
    )
    .map_err(|_| format!("Branch `{revision}` does not exist."))?;
    Ok(revision.to_string())
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

pub(super) fn validate_remote_url(remote_url: Option<&str>) -> Result<String, String> {
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

fn validate_paths(paths: Option<&[String]>) -> Result<Vec<&str>, String> {
    let paths = paths.unwrap_or_default();
    if paths.is_empty() || paths.len() > MAX_ACTION_PATHS {
        return Err("Select between 1 and 2000 files.".to_string());
    }
    paths
        .iter()
        .map(|path| {
            if path.is_empty()
                || path.len() > 4_096
                || path.chars().any(char::is_control)
                || Path::new(path).is_absolute()
            {
                Err(format!("`{path}` is not a repository-relative path."))
            } else {
                Ok(path.as_str())
            }
        })
        .collect()
}

fn validate_stash_reference(stash_ref: Option<&str>) -> Result<String, String> {
    let reference = stash_ref.unwrap_or_default().trim();
    let index = reference
        .strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'));
    if index.is_some_and(|index| {
        !index.is_empty() && index.chars().all(|character| character.is_ascii_digit())
    }) {
        Ok(reference.to_string())
    } else {
        Err("Select a valid stash.".to_string())
    }
}

fn single_line_message(message: Option<&str>, maximum: usize) -> Option<String> {
    let message = message.unwrap_or_default().trim();
    (!message.is_empty() && message.chars().count() <= maximum)
        .then(|| message.split_whitespace().collect::<Vec<_>>().join(" "))
}

pub(super) fn current_branch(repository: &Path) -> Result<String, String> {
    run_optional(
        "git",
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        repository,
    )
    .filter(|branch| !branch.is_empty())
    .ok_or_else(|| "Switch to a branch first.".to_string())
}

fn has_head(repository: &Path) -> bool {
    run_optional("git", &["rev-parse", "--verify", "--quiet", "HEAD"], repository).is_some()
}

fn run_with_paths(repository: &Path, prefix: &[&str], paths: &[&str]) -> Result<(), String> {
    let mut batch: Vec<&str> = Vec::new();
    let mut batch_chars = 0;
    for path in paths {
        if !batch.is_empty() && batch_chars + path.len() > MAX_PATH_ARGUMENT_CHARS {
            run_path_batch(repository, prefix, &batch)?;
            batch.clear();
            batch_chars = 0;
        }
        batch.push(path);
        batch_chars += path.len() + 1;
    }
    if !batch.is_empty() {
        run_path_batch(repository, prefix, &batch)?;
    }
    Ok(())
}

fn run_path_batch(repository: &Path, prefix: &[&str], paths: &[&str]) -> Result<(), String> {
    let mut arguments = prefix.to_vec();
    arguments.push("--");
    arguments.extend_from_slice(paths);
    run_required("git", &arguments, repository).map(|_| ())
}

pub(super) fn push_remote(repository: &Path) -> Result<String, String> {
    let remotes = run_required("git", &["remote"], repository)?;
    let remotes = remotes.lines().map(str::trim).collect::<Vec<_>>();
    remotes
        .iter()
        .find(|remote| **remote == "origin")
        .or_else(|| remotes.first())
        .filter(|remote| !remote.is_empty())
        .map(|remote| remote.to_string())
        .ok_or_else(|| "Add a Git remote before pushing.".to_string())
}

fn push(repository: &Path, force: bool) -> Result<(), String> {
    let branch = current_branch(repository)?;
    let has_upstream = run_optional(
        "git",
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        repository,
    )
    .is_some_and(|upstream| !upstream.is_empty());
    let mut arguments = vec!["push"];
    if force {
        arguments.push("--force-with-lease");
    }
    let remote = if has_upstream {
        None
    } else {
        Some(push_remote(repository)?)
    };
    if let Some(remote) = remote.as_deref() {
        arguments.extend(["--set-upstream", remote, &branch]);
    }
    run_required("git", &arguments, repository).map(|_| ())
}

fn upstream_branch(repository: &Path) -> Result<String, String> {
    run_optional(
        "git",
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        repository,
    )
    .filter(|upstream| !upstream.is_empty())
    .ok_or_else(|| "This branch has no upstream. Choose a branch or commit to reset to.".to_string())
}

fn reset(
    repository: &Path,
    start_point: Option<&str>,
    reset_mode: Option<&str>,
) -> Result<(), String> {
    let mode = match reset_mode {
        None | Some("keep") => "--mixed",
        Some("discard") => "--hard",
        Some(_) => return Err("Choose whether to keep or discard local changes.".to_string()),
    };
    if let Some(operation) = current_operation(repository) {
        return Err(format!("Finish or abort the {operation} before resetting."));
    }
    let target = match start_point.map(str::trim).filter(|value| !value.is_empty()) {
        Some(revision) => validate_revision(Some(revision), repository)?,
        None => upstream_branch(repository)?,
    };
    run_required("git", &["reset", "--quiet", mode, &target], repository).map(|_| ())
}

fn control_operation(repository: &Path, control: &str) -> Result<(), String> {
    let operation = current_operation(repository)
        .ok_or_else(|| "No merge, rebase, or cherry-pick is in progress.".to_string())?;
    let arguments: Vec<&str> = match (operation.as_str(), control) {
        ("merge", "continue") => vec!["commit", "--no-edit"],
        ("merge", "abort") => vec!["merge", "--abort"],
        ("merge", _) => return Err("A merge cannot skip a commit.".to_string()),
        (command, "continue") => vec![command, "--continue"],
        (command, "abort") => vec![command, "--abort"],
        (command, _) => vec![command, "--skip"],
    };
    let label = match control {
        "continue" => "Continuing",
        "abort" => "Aborting",
        _ => "Skipping",
    };
    stop_with_conflicts(repository, &arguments, label)
}

fn stop_with_conflicts(repository: &Path, arguments: &[&str], label: &str) -> Result<(), String> {
    let output = command_output("git", arguments, repository)?;
    if output.status.success() {
        return Ok(());
    }
    if current_operation(repository).is_some() {
        return Err(format!(
            "{label} stopped with conflicts. Resolve them, stage the files, then continue or abort."
        ));
    }
    Err(output_error("git", arguments, &output))
}

pub(super) fn execute_workspace_git_action(
    request: WorkspaceGitActionRequest,
) -> Result<WorkspaceGitOverview, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    let force = request.force == Some(true);
    match request.action.as_str() {
        "fetch" => {
            run_required("git", &FETCH_ARGUMENTS, &repository)?;
        }
        "pull" => {
            run_required(
                "git",
                &["pull", "--ff-only", "--no-show-forced-updates"],
                &repository,
            )?;
        }
        "push" => push(&repository, force)?,
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
            let start_point = request
                .start_point
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| validate_revision(Some(value), &repository))
                .transpose()?;
            let mut arguments = vec!["switch", "-c", branch.as_str()];
            if let Some(start_point) = start_point.as_deref() {
                arguments.push(start_point);
            }
            run_required("git", &arguments, &repository)?;
        }
        "create-stacked-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), &repository)?;
            stack::create_stacked_branch(&repository, &branch)?;
        }
        "stack-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), &repository)?;
            let parent = validate_branch_name(request.parent_branch.as_deref(), &repository)?;
            stack::stack_branch(&repository, &branch, &parent)?;
        }
        "unstack-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), &repository)?;
            stack::clear_parent(&repository, &branch)?;
        }
        "delete-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), &repository)?;
            stack::delete_branch(&repository, &branch, force)?;
        }
        "restack" => stack::restack(&repository)?,
        "reset" => reset(
            &repository,
            request.start_point.as_deref(),
            request.reset_mode.as_deref(),
        )?,
        "submit-pull-requests" => {
            stack::submit_pull_requests(&repository, request.draft == Some(true))?
        }
        "merge" => {
            let branch = validate_revision(request.branch_name.as_deref(), &repository)?;
            stop_with_conflicts(&repository, &["merge", "--no-edit", &branch], "Merge")?;
        }
        "rebase" => {
            let branch = validate_revision(request.branch_name.as_deref(), &repository)?;
            stop_with_conflicts(&repository, &["rebase", &branch], "Rebase")?;
        }
        "continue-operation" => control_operation(&repository, "continue")?,
        "abort-operation" => control_operation(&repository, "abort")?,
        "skip-operation" => control_operation(&repository, "skip")?,
        "stage" => {
            let paths = validate_paths(request.paths.as_deref())?;
            run_with_paths(&repository, &["add", "--all"], &paths)?;
        }
        "unstage" => {
            let paths = validate_paths(request.paths.as_deref())?;
            if has_head(&repository) {
                run_with_paths(&repository, &["restore", "--staged"], &paths)?;
            } else {
                run_with_paths(&repository, &["rm", "--cached", "-r", "--quiet"], &paths)?;
            }
        }
        "stage-all" => {
            run_required("git", &["add", "--all"], &repository)?;
        }
        "unstage-all" => {
            if has_head(&repository) {
                run_required("git", &["reset", "--quiet"], &repository)?;
            } else {
                run_required("git", &["rm", "--cached", "-r", "--quiet", "."], &repository)?;
            }
        }
        "commit" => {
            let message = request.message.as_deref().unwrap_or_default().trim();
            if message.is_empty() || message.chars().count() > MAX_COMMIT_MESSAGE_CHARS {
                return Err("Enter a commit message.".to_string());
            }
            run_required("git", &["commit", "-m", message], &repository)?;
        }
        "stash-push" => {
            let message =
                single_line_message(request.message.as_deref(), MAX_STASH_MESSAGE_CHARS);
            // Stash builds internal pathspecs that literal pathspec mode would break.
            let mut arguments = vec!["--no-literal-pathspecs", "stash", "push"];
            if request.include_untracked == Some(true) {
                arguments.push("--include-untracked");
            }
            if let Some(message) = message.as_deref() {
                arguments.extend(["--message", message]);
            }
            run_required("git", &arguments, &repository)?;
        }
        "stash-apply" | "stash-pop" | "stash-drop" => {
            let reference = validate_stash_reference(request.stash_ref.as_deref())?;
            let operation = request.action.trim_start_matches("stash-");
            stop_with_conflicts(
                &repository,
                &["--no-literal-pathspecs", "stash", operation, &reference],
                "Applying the stash",
            )?;
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
