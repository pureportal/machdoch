use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

use super::{
    command_output, current_operation, fsmonitor, git_directories, index_update, output_error,
    overview, pull_requests, repository_context, run_optional, run_required, stack, status, undo,
    worktrees, WorkspaceGitActionRequest, WorkspaceGitOverview, FETCH_ARGUMENTS,
};

const MAX_ACTION_PATHS: usize = 2_000;
const MAX_PATH_ARGUMENT_CHARS: usize = 8_000;
const MAX_COMMIT_MESSAGE_CHARS: usize = 20_000;
const MAX_STASH_MESSAGE_CHARS: usize = 500;
const MAX_PATCH_CHARS: usize = 2_000_000;
const MAX_CO_AUTHORS: usize = 20;
const MAX_DELETED_BRANCHES: usize = 500;

static NEXT_PATCH: AtomicU64 = AtomicU64::new(1);

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
    resolve_revision(revision, repository)?;
    Ok(revision.unwrap_or_default().trim().to_string())
}

pub(super) fn resolve_revision(
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
    .map(|commit| commit.trim().to_string())
    .map_err(|_| format!("Branch `{revision}` does not exist."))
}

fn validate_tag_name(tag_name: Option<&str>, repository: &Path) -> Result<String, String> {
    let name = tag_name.unwrap_or_default().trim();
    if name.is_empty()
        || name.starts_with('-')
        || name.chars().count() > 255
        || name.chars().any(char::is_control)
    {
        return Err("Enter a valid tag name.".to_string());
    }
    run_required(
        "git",
        &["check-ref-format", &format!("refs/tags/{name}")],
        repository,
    )
    .map_err(|_| "Enter a valid tag name.".to_string())?;
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

fn validate_commit_id(commit: Option<&str>) -> Result<String, String> {
    let commit = commit.unwrap_or_default().trim();
    if (4..=64).contains(&commit.len()) && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(commit.to_string())
    } else {
        Err("Select a valid commit.".to_string())
    }
}

fn validate_co_authors(co_authors: Option<&[String]>) -> Result<Vec<String>, String> {
    let co_authors = co_authors.unwrap_or_default();
    if co_authors.len() > MAX_CO_AUTHORS {
        return Err("Add at most 20 co-authors.".to_string());
    }
    co_authors
        .iter()
        .map(|author| {
            let author = author.trim();
            let valid = !author.is_empty()
                && author.chars().count() <= 300
                && !author.chars().any(char::is_control)
                && author.contains('<')
                && author.ends_with('>');
            if valid {
                Ok(author.to_string())
            } else {
                Err(format!("`{author}` is not a co-author like Name <email>."))
            }
        })
        .collect()
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
    run_optional(
        "git",
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        repository,
    )
    .is_some()
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

fn upstream(repository: &Path) -> Option<String> {
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
}

pub(super) fn push(repository: &Path, force: bool) -> Result<(), String> {
    let branch = current_branch(repository)?;
    let mut arguments = vec!["push"];
    if force {
        arguments.push("--force-with-lease");
    }
    let remote = match upstream(repository) {
        Some(_) => None,
        None => Some(push_remote(repository)?),
    };
    if let Some(remote) = remote.as_deref() {
        arguments.extend(["--set-upstream", remote, &branch]);
    }
    run_required("git", &arguments, repository).map(|_| ())
}

fn set_upstream(repository: &Path) -> Result<(), String> {
    let branch = current_branch(repository)?;
    let remote = push_remote(repository)?;
    let remote_branch = format!("{remote}/{branch}");
    let tracked = run_optional(
        "git",
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{remote_branch}"),
        ],
        repository,
    )
    .is_some();
    if tracked {
        run_required(
            "git",
            &["branch", &format!("--set-upstream-to={remote_branch}")],
            repository,
        )
    } else {
        run_required(
            "git",
            &["push", "--set-upstream", &remote, &branch],
            repository,
        )
    }
    .map(|_| ())
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
        None => upstream(repository).ok_or_else(|| {
            "This branch has no upstream. Choose a branch or commit to reset to.".to_string()
        })?,
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

fn commit(repository: &Path, request: &WorkspaceGitActionRequest) -> Result<(), String> {
    let amend = request.amend == Some(true);
    let message = request.message.as_deref().unwrap_or_default().trim();
    if message.chars().count() > MAX_COMMIT_MESSAGE_CHARS || (message.is_empty() && !amend) {
        return Err("Enter a commit message.".to_string());
    }
    let co_authors = validate_co_authors(request.co_authors.as_deref())?;
    let trailers = co_authors
        .iter()
        .map(|author| format!("Co-authored-by: {author}"))
        .collect::<Vec<_>>();
    let mut arguments = vec!["commit"];
    if amend {
        arguments.push("--amend");
    }
    if request.sign_off == Some(true) {
        arguments.push("--signoff");
    }
    for trailer in &trailers {
        arguments.extend(["--trailer", trailer]);
    }
    if message.is_empty() {
        arguments.push("--no-edit");
    } else {
        arguments.extend(["-m", message]);
    }
    run_required("git", &arguments, repository)?;
    if request.push_after_commit == Some(true) {
        push(repository, request.force == Some(true))?;
    }
    Ok(())
}

fn patch_paths(patch: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch.lines() {
        let Some(path) = line
            .strip_prefix("--- a/")
            .or_else(|| line.strip_prefix("+++ b/"))
        else {
            continue;
        };
        let path = path.trim_end_matches('\t').to_string();
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

fn apply_patch(repository: &Path, request: &WorkspaceGitActionRequest) -> Result<(), String> {
    let patch = request.patch.as_deref().unwrap_or_default();
    if patch.trim().is_empty() || patch.len() > MAX_PATCH_CHARS || !patch.contains("@@") {
        return Err("Select lines to change.".to_string());
    }
    let index = match request.patch_target.as_deref() {
        Some("index") => true,
        Some("worktree") => false,
        _ => return Err("Choose whether to change the index or the working tree.".to_string()),
    };
    let directories = git_directories(repository)
        .ok_or_else(|| "The selected folder is not a Git repository.".to_string())?;
    let patch_file = directories.git_dir.join(format!(
        "machdoch-{}-{}.patch",
        std::process::id(),
        NEXT_PATCH.fetch_add(1, Ordering::Relaxed)
    ));
    let mut contents = patch.to_string();
    if !contents.ends_with('\n') {
        contents.push('\n');
    }
    fs::write(&patch_file, contents)
        .map_err(|error| format!("Could not prepare the patch: {error}"))?;
    let patch_path = crate::workspace_tools::terminal::shell_compatible_path(&patch_file)
        .display()
        .to_string();
    let mut arguments = vec!["apply", "--whitespace=nowarn", "--recount"];
    if index {
        arguments.push("--cached");
    }
    if request.reverse == Some(true) {
        arguments.push("--reverse");
    }
    arguments.push(&patch_path);
    let result = run_required("git", &arguments, repository);
    let _ = fs::remove_file(&patch_file);
    result.map(|_| ()).map_err(|error| {
        format!(
            "The selected lines no longer match the file. Reload the diff and try again. ({error})"
        )
    })
}

fn discard(repository: &Path, paths: &[&str]) -> Result<(), String> {
    if !has_head(repository) {
        return Err("Create the first commit before discarding changes.".to_string());
    }
    let pathspecs = paths
        .iter()
        .map(|path| format!(":(literal){path}"))
        .collect::<Vec<_>>();
    let mut arguments = vec![
        "--no-literal-pathspecs",
        "stash",
        "push",
        "--include-untracked",
        "--message",
        "Discarded changes",
        "--",
    ];
    arguments.extend(pathspecs.iter().map(String::as_str));
    run_required("git", &arguments, repository).map(|_| ())
}

fn resolve_conflict(repository: &Path, paths: &[&str], side: Option<&str>) -> Result<(), String> {
    let side = match side {
        Some("ours") => "--ours",
        Some("theirs") => "--theirs",
        _ => return Err("Choose ours or theirs.".to_string()),
    };
    run_with_paths(repository, &["checkout", side], paths)?;
    run_with_paths(repository, &["add"], paths)
}

fn delete_branches(
    repository: &Path,
    branch_names: Option<&[String]>,
    force: bool,
) -> Result<(), String> {
    let branch_names = branch_names.unwrap_or_default();
    if branch_names.is_empty() || branch_names.len() > MAX_DELETED_BRANCHES {
        return Err("Select between 1 and 500 branches.".to_string());
    }
    let mut failures = Vec::new();
    for name in branch_names {
        let result = validate_branch_name(Some(name), repository)
            .and_then(|branch| stack::delete_branch(repository, &branch, force));
        if let Err(error) = result {
            failures.push(format!("{name}: {error}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

fn remove_index_lock(repository: &Path) -> Result<(), String> {
    let directories = git_directories(repository)
        .ok_or_else(|| "The selected folder is not a Git repository.".to_string())?;
    let lock = directories.git_dir.join("index.lock");
    match fs::remove_file(&lock) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err("The repository is not locked anymore.".to_string())
        }
        Err(error) => Err(format!("Could not remove {}: {error}", lock.display())),
    }
}

fn tag_action(repository: &Path, request: &WorkspaceGitActionRequest) -> Result<(), String> {
    let tag = validate_tag_name(request.tag_name.as_deref(), repository)?;
    match request.action.as_str() {
        "create-tag" => {
            let start_point = request
                .start_point
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| validate_revision(Some(value), repository))
                .transpose()?;
            let message = single_line_message(request.message.as_deref(), MAX_COMMIT_MESSAGE_CHARS);
            let mut arguments = vec!["tag"];
            if let Some(message) = message.as_deref() {
                arguments.extend(["--annotate", "--message", message]);
            }
            arguments.extend(["--end-of-options", &tag]);
            arguments.extend(start_point.as_deref());
            run_required("git", &arguments, repository)?;
        }
        "push-tag" => {
            let remote = push_remote(repository)?;
            run_required(
                "git",
                &["push", &remote, &format!("refs/tags/{tag}")],
                repository,
            )?;
        }
        _ => {
            if request.remote == Some(true) {
                let remote = push_remote(repository)?;
                run_required(
                    "git",
                    &["push", &remote, "--delete", &format!("refs/tags/{tag}")],
                    repository,
                )?;
            }
            run_required(
                "git",
                &["tag", "--delete", "--end-of-options", &tag],
                repository,
            )?;
        }
    }
    Ok(())
}

fn run_action(
    repository: &Path,
    request: &WorkspaceGitActionRequest,
) -> Result<Option<Vec<String>>, String> {
    let force = request.force == Some(true);
    match request.action.as_str() {
        "fetch" => {
            run_required("git", &FETCH_ARGUMENTS, repository)?;
        }
        "pull" => {
            run_required(
                "git",
                &["pull", "--ff-only", "--no-show-forced-updates"],
                repository,
            )?;
        }
        "pull-rebase" => stop_with_conflicts(
            repository,
            &["pull", "--rebase", "--no-show-forced-updates"],
            "Pulling with rebase",
        )?,
        "push" => {
            push(repository, force)?;
            pull_requests::forget(repository);
        }
        "set-upstream" => set_upstream(repository)?,
        "checkout" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), repository)?;
            run_required("git", &["switch", &branch], repository)?;
        }
        "checkout-remote" => {
            let branch = request.branch_name.as_deref().unwrap_or_default().trim();
            if branch.is_empty() || branch.starts_with('-') {
                return Err("Select a valid remote branch.".to_string());
            }
            run_required(
                "git",
                &["check-ref-format", &format!("refs/remotes/{branch}")],
                repository,
            )
            .map_err(|_| "Select a valid remote branch.".to_string())?;
            run_required("git", &["switch", "--track", branch], repository)?;
        }
        "create-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), repository)?;
            let start_point = request
                .start_point
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| validate_revision(Some(value), repository))
                .transpose()?;
            let mut arguments = vec!["switch", "-c", branch.as_str()];
            if let Some(start_point) = start_point.as_deref() {
                arguments.push(start_point);
            }
            run_required("git", &arguments, repository)?;
        }
        "create-stacked-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), repository)?;
            stack::create_stacked_branch(repository, &branch)?;
        }
        "stack-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), repository)?;
            let parent = validate_branch_name(request.parent_branch.as_deref(), repository)?;
            stack::stack_branch(repository, &branch, &parent)?;
        }
        "unstack-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), repository)?;
            stack::clear_parent(repository, &branch)?;
        }
        "delete-branch" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), repository)?;
            stack::delete_branch(repository, &branch, force)?;
        }
        "delete-branches" => delete_branches(repository, request.branch_names.as_deref(), force)?,
        "restack" => stack::restack(repository)?,
        "reset" => reset(
            repository,
            request.start_point.as_deref(),
            request.reset_mode.as_deref(),
        )?,
        "undo" => undo::undo(repository, request.target.as_deref())?,
        "submit-pull-requests" => {
            stack::submit_pull_requests(repository, request.draft == Some(true))?;
            pull_requests::forget(repository);
        }
        "create-pull-request" => {
            let title = single_line_message(request.title.as_deref(), 500)
                .ok_or_else(|| "Enter a pull request title.".to_string())?;
            let base = request
                .base_branch
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| validate_branch_name(Some(value), repository))
                .transpose()?;
            pull_requests::create_pull_request(
                repository,
                &title,
                request.body.as_deref(),
                base.as_deref(),
                request.draft == Some(true),
            )?;
        }
        "merge" => {
            let branch = validate_revision(request.branch_name.as_deref(), repository)?;
            stop_with_conflicts(repository, &["merge", "--no-edit", &branch], "Merge")?;
        }
        "rebase" => {
            let branch = validate_revision(request.branch_name.as_deref(), repository)?;
            stop_with_conflicts(repository, &["rebase", &branch], "Rebase")?;
        }
        "cherry-pick" => {
            let commit = validate_commit_id(request.commit.as_deref())?;
            stop_with_conflicts(repository, &["cherry-pick", &commit], "Cherry-pick")?;
        }
        "revert" => {
            let commit = validate_commit_id(request.commit.as_deref())?;
            stop_with_conflicts(repository, &["revert", "--no-edit", &commit], "Revert")?;
        }
        "create-tag" | "push-tag" | "delete-tag" => tag_action(repository, request)?,
        "continue-operation" => control_operation(repository, "continue")?,
        "abort-operation" => control_operation(repository, "abort")?,
        "skip-operation" => control_operation(repository, "skip")?,
        "stage" => {
            let paths = validate_paths(request.paths.as_deref())?;
            if paths.iter().any(|path| path.ends_with('/')) {
                run_with_paths(repository, &["add", "--all"], &paths)?;
            } else if !index_update::update_paths(
                repository,
                &paths,
                index_update::IndexUpdate::Stage,
            )? {
                run_with_paths(repository, &["update-index", "--add", "--remove"], &paths)?;
            }
            return Ok(Some(paths.iter().map(|path| path.to_string()).collect()));
        }
        "mark-resolved" => {
            let paths = validate_paths(request.paths.as_deref())?;
            run_with_paths(repository, &["add", "--all"], &paths)?;
            return Ok(Some(paths.iter().map(|path| path.to_string()).collect()));
        }
        "unstage" => {
            let paths = validate_paths(request.paths.as_deref())?;
            if !index_update::update_paths(repository, &paths, index_update::IndexUpdate::Unstage)?
            {
                if has_head(repository) {
                    run_with_paths(repository, &["restore", "--staged"], &paths)?;
                } else {
                    run_with_paths(repository, &["rm", "--cached", "-r", "--quiet"], &paths)?;
                }
            }
            return Ok(Some(paths.iter().map(|path| path.to_string()).collect()));
        }
        "discard" => {
            let paths = validate_paths(request.paths.as_deref())?;
            discard(repository, &paths)?;
            return Ok(Some(paths.iter().map(|path| path.to_string()).collect()));
        }
        "resolve-conflict" => {
            let paths = validate_paths(request.paths.as_deref())?;
            resolve_conflict(repository, &paths, request.side.as_deref())?;
            return Ok(Some(paths.iter().map(|path| path.to_string()).collect()));
        }
        "apply-patch" => {
            apply_patch(repository, request)?;
            let paths = patch_paths(request.patch.as_deref().unwrap_or_default());
            return Ok((!paths.is_empty()).then_some(paths));
        }
        "stage-all" => {
            run_required("git", &["add", "--all"], repository)?;
        }
        "unstage-all" => {
            if has_head(repository) {
                run_required("git", &["reset", "--quiet"], repository)?;
            } else {
                run_required("git", &["rm", "--cached", "-r", "--quiet", "."], repository)?;
            }
        }
        "commit" => commit(repository, request)?,
        "stash-push" => {
            let message = single_line_message(request.message.as_deref(), MAX_STASH_MESSAGE_CHARS);
            // Stash builds internal pathspecs that literal pathspec mode would break.
            let mut arguments = vec!["--no-literal-pathspecs", "stash", "push"];
            if request.include_untracked == Some(true) {
                arguments.push("--include-untracked");
            }
            if let Some(message) = message.as_deref() {
                arguments.extend(["--message", message]);
            }
            run_required("git", &arguments, repository)?;
        }
        "stash-apply" | "stash-pop" | "stash-drop" => {
            let reference = validate_stash_reference(request.stash_ref.as_deref())?;
            let operation = request.action.trim_start_matches("stash-");
            stop_with_conflicts(
                repository,
                &["--no-literal-pathspecs", "stash", operation, &reference],
                "Applying the stash",
            )?;
        }
        "add-remote" => {
            let name = validate_remote_name(request.remote_name.as_deref())?;
            let url = validate_remote_url(request.remote_url.as_deref())?;
            run_required("git", &["remote", "add", &name, &url], repository)?;
        }
        "remove-remote" => {
            let name = validate_remote_name(request.remote_name.as_deref())?;
            run_required("git", &["remote", "remove", &name], repository)?;
        }
        "add-worktree" => {
            let branch = validate_branch_name(request.branch_name.as_deref(), repository)?;
            let start_point = request
                .start_point
                .as_deref()
                .map(|revision| validate_revision(Some(revision), repository))
                .transpose()?;
            worktrees::add_worktree(repository, &branch, start_point.as_deref())?;
        }
        "remove-worktree" | "lock-worktree" | "unlock-worktree" => {
            let path = request
                .worktree_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .ok_or_else(|| "Select a worktree.".to_string())?;
            worktrees::change_worktree(repository, &request.action, path, force)?;
        }
        "prune-worktrees" => {
            run_required("git", &["worktree", "prune"], repository)?;
        }
        "remove-index-lock" => remove_index_lock(repository)?,
        _ => return Err("Unsupported workspace Git action.".to_string()),
    }
    Ok(None)
}

pub(super) fn execute_workspace_git_action(
    request: WorkspaceGitActionRequest,
) -> Result<WorkspaceGitOverview, String> {
    let (workspace, repository) =
        repository_context(&request.workspace_root, &request.repository_root)?;
    let options = overview::OverviewOptions::parse(
        request.sections.as_deref(),
        request.untracked_files.as_deref(),
    )?;
    crate::workspace_watch::ensure_watching(&workspace);
    let prepared = status::prepare_path_refresh(&repository);
    let changed_paths = run_action(&repository, &request)?;
    let change = match request.action.as_str() {
        "stage" => Some(status::IndexChange::Staged),
        "unstage" => Some(status::IndexChange::Unstaged),
        _ => None,
    };
    match (changed_paths, prepared) {
        (Some(paths), Some(prepared)) => {
            let paths = paths.iter().map(String::as_str).collect::<Vec<_>>();
            status::refresh_paths(
                &repository,
                prepared,
                &paths,
                change,
                fsmonitor::enabled_for(&workspace),
            )?;
        }
        _ => status::forget(&repository),
    }
    overview::load_overview(&request.workspace_root, &request.repository_root, &options)
}

#[cfg(test)]
mod tests {
    use super::patch_paths;

    #[test]
    fn reads_the_paths_a_patch_touches() {
        let patch = "diff --git a/src/a b.ts b/src/a b.ts\n--- a/src/a b.ts\n+++ b/src/a b.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n";
        assert_eq!(patch_paths(patch), vec!["src/a b.ts", "new.ts"]);
    }
}
