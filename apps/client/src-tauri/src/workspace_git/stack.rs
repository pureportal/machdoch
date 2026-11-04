use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    path::Path,
    thread,
};

use serde_json::Value;

use super::{
    actions::{current_branch, push_remote},
    command_output, command_succeeds, current_operation, output_error, run_optional,
    run_required, WorkspaceGitBranch,
};

const PARENT_KEY: &str = "machdoch-parent";
const PARENT_REVISION_KEY: &str = "machdoch-parent-revision";
const MAX_RESTACK_CHECKS: usize = 64;
const MAX_PARALLEL_RESTACK_CHECKS: usize = 8;
const STACK_SECTION_START: &str = "<!-- machdoch-stack -->";
const STACK_SECTION_END: &str = "<!-- /machdoch-stack -->";

struct OpenPullRequest {
    number: u64,
    base: String,
    body: String,
}

fn config_key(branch: &str, key: &str) -> String {
    format!("branch.{branch}.{key}")
}

pub(super) fn read_parents(repository: &Path) -> BTreeMap<String, String> {
    run_optional(
        "git",
        &[
            "config",
            "--local",
            "--get-regexp",
            r"^branch\..*\.machdoch-parent$",
        ],
        repository,
    )
    .unwrap_or_default()
    .lines()
    .filter_map(|line| {
        let (key, parent) = line.split_once(' ')?;
        let branch = key
            .strip_prefix("branch.")?
            .strip_suffix(".machdoch-parent")?;
        let parent = parent.trim();
        (!parent.is_empty()).then(|| (branch.to_string(), parent.to_string()))
    })
    .collect()
}

fn branch_exists(repository: &Path, branch: &str) -> Result<bool, String> {
    command_succeeds(
        "git",
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
        repository,
    )
}

fn existing_parents(repository: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut parents = BTreeMap::new();
    for (branch, parent) in read_parents(repository) {
        if branch_exists(repository, &branch)? {
            parents.insert(branch, parent);
        }
    }
    Ok(parents)
}

fn resolve_commit(repository: &Path, revision: &str) -> Result<String, String> {
    run_required(
        "git",
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{revision}^{{commit}}"),
        ],
        repository,
    )
}

fn is_ancestor(repository: &Path, ancestor: &str, descendant: &str) -> Result<bool, String> {
    command_succeeds(
        "git",
        &["merge-base", "--is-ancestor", ancestor, descendant],
        repository,
    )
}

fn set_config(repository: &Path, branch: &str, key: &str, value: &str) -> Result<(), String> {
    run_required(
        "git",
        &["config", "--local", &config_key(branch, key), value],
        repository,
    )
    .map(|_| ())
}

fn write_parent(
    repository: &Path,
    branch: &str,
    parent: &str,
    parent_revision: &str,
) -> Result<(), String> {
    set_config(repository, branch, PARENT_KEY, parent)?;
    set_config(repository, branch, PARENT_REVISION_KEY, parent_revision)
}

pub(super) fn clear_parent(repository: &Path, branch: &str) -> Result<(), String> {
    for key in [PARENT_KEY, PARENT_REVISION_KEY] {
        let key = config_key(branch, key);
        let arguments = ["config", "--local", "--unset", key.as_str()];
        let output = command_output("git", &arguments, repository)?;
        // Git exits with 5 when the key is not set.
        if !output.status.success() && output.status.code() != Some(5) {
            return Err(output_error("git", &arguments, &output));
        }
    }
    Ok(())
}

fn would_cycle(parents: &BTreeMap<String, String>, branch: &str, parent: &str) -> bool {
    let mut seen = HashSet::new();
    let mut cursor = Some(parent);
    while let Some(name) = cursor {
        if name == branch || !seen.insert(name) {
            return true;
        }
        cursor = parents.get(name).map(String::as_str);
    }
    false
}

fn stack_descendants(parents: &BTreeMap<String, String>, root: &str) -> Vec<String> {
    let mut order = Vec::new();
    let mut seen = HashSet::from([root.to_string()]);
    let mut queue = VecDeque::from([root.to_string()]);
    while let Some(current) = queue.pop_front() {
        for (child, parent) in parents {
            if parent == &current && seen.insert(child.clone()) {
                order.push(child.clone());
                queue.push_back(child.clone());
            }
        }
    }
    order
}

fn stack_ancestors(parents: &BTreeMap<String, String>, branch: &str) -> Vec<String> {
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = branch.to_string();
    while let Some(parent) = parents.get(&cursor) {
        if !seen.insert(cursor.clone()) {
            break;
        }
        chain.push(cursor.clone());
        cursor = parent.clone();
    }
    chain.reverse();
    chain
}

fn stack_trunk(parents: &BTreeMap<String, String>, branch: &str) -> String {
    let mut seen = HashSet::new();
    let mut cursor = branch.to_string();
    while let Some(parent) = parents.get(&cursor) {
        if !seen.insert(cursor.clone()) {
            break;
        }
        cursor = parent.clone();
    }
    cursor
}

pub(super) fn annotate_branches(
    repository: &Path,
    parents: &BTreeMap<String, String>,
    branches: &mut [WorkspaceGitBranch],
) {
    if parents.is_empty() {
        return;
    }
    let local = branches
        .iter()
        .map(|branch| branch.name.clone())
        .collect::<HashSet<_>>();
    let mut checks = Vec::new();
    for (index, branch) in branches.iter_mut().enumerate() {
        let Some(parent) = parents.get(&branch.name) else {
            continue;
        };
        branch.parent = Some(parent.clone());
        if local.contains(parent) && checks.len() < MAX_RESTACK_CHECKS {
            checks.push((index, parent.clone(), branch.name.clone()));
        }
    }
    for batch in checks.chunks(MAX_PARALLEL_RESTACK_CHECKS) {
        let results = thread::scope(|scope| {
            batch
                .iter()
                .map(|(_, parent, name)| {
                    scope.spawn(move || !is_ancestor(repository, parent, name).unwrap_or(true))
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|worker| worker.join().unwrap_or(false))
                .collect::<Vec<_>>()
        });
        for ((index, _, _), needs_restack) in batch.iter().zip(results) {
            branches[*index].needs_restack = needs_restack;
        }
    }
}

pub(super) fn create_stacked_branch(repository: &Path, branch: &str) -> Result<(), String> {
    let parent = current_branch(repository)?;
    let parent_revision = resolve_commit(repository, "HEAD")
        .map_err(|_| format!("Commit on `{parent}` before stacking a branch on it."))?;
    run_required("git", &["switch", "-c", branch], repository)?;
    write_parent(repository, branch, &parent, &parent_revision)
}

pub(super) fn stack_branch(repository: &Path, branch: &str, parent: &str) -> Result<(), String> {
    if branch == parent {
        return Err("A branch cannot be stacked on itself.".to_string());
    }
    for name in [branch, parent] {
        if !branch_exists(repository, name)? {
            return Err(format!("Branch `{name}` does not exist."));
        }
    }
    if would_cycle(&read_parents(repository), branch, parent) {
        return Err(format!(
            "Stacking `{branch}` on `{parent}` would create a cycle."
        ));
    }
    let base = run_required("git", &["merge-base", parent, branch], repository)?;
    write_parent(repository, branch, parent, &base)
}

pub(super) fn delete_branch(repository: &Path, branch: &str, force: bool) -> Result<(), String> {
    if current_branch(repository).ok().as_deref() == Some(branch) {
        return Err("Switch to another branch before deleting this one.".to_string());
    }
    let parents = read_parents(repository);
    let grandparent = parents.get(branch).cloned();
    run_required(
        "git",
        &["branch", if force { "-D" } else { "-d" }, branch],
        repository,
    )
    .map_err(|error| {
        if error.contains("not fully merged") {
            format!("`{branch}` has unmerged commits. Delete it anyway to discard them.")
        } else {
            error
        }
    })?;
    for (child, parent) in &parents {
        if parent != branch {
            continue;
        }
        match grandparent.as_deref() {
            Some(grandparent) => set_config(repository, child, PARENT_KEY, grandparent)?,
            None => clear_parent(repository, child)?,
        }
    }
    Ok(())
}

pub(super) fn restack(repository: &Path) -> Result<(), String> {
    if current_operation(repository).is_some() {
        return Err("Finish or abort the current operation before restacking.".to_string());
    }
    let original = current_branch(repository)?;
    let parents = existing_parents(repository)?;
    let trunk = stack_trunk(&parents, &original);
    let order = stack_descendants(&parents, &trunk);
    if order.is_empty() {
        return Err("This branch is not part of a stack.".to_string());
    }
    for branch in &order {
        let parent = &parents[branch];
        if !branch_exists(repository, parent)? {
            return Err(format!(
                "`{branch}` is stacked on `{parent}`, which no longer exists. Stack it on another branch first."
            ));
        }
        let parent_head = resolve_commit(repository, parent)?;
        if !is_ancestor(repository, parent, branch)? {
            let stored_base = run_optional(
                "git",
                &[
                    "config",
                    "--local",
                    "--get",
                    &config_key(branch, PARENT_REVISION_KEY),
                ],
                repository,
            )
            .filter(|revision| {
                !revision.is_empty() && is_ancestor(repository, revision, branch).unwrap_or(false)
            });
            let base = match stored_base {
                Some(base) => base,
                None => run_required("git", &["merge-base", parent, branch], repository)?,
            };
            let arguments = ["rebase", "--onto", parent.as_str(), base.as_str(), branch.as_str()];
            let output = command_output("git", &arguments, repository)?;
            if !output.status.success() {
                if current_operation(repository).is_some() {
                    return Err(format!(
                        "Restacking `{branch}` stopped with conflicts. Resolve them, continue the rebase, then restack again."
                    ));
                }
                return Err(output_error("git", &arguments, &output));
            }
        }
        set_config(repository, branch, PARENT_REVISION_KEY, &parent_head)?;
    }
    run_required("git", &["switch", &original], repository).map(|_| ())
}

fn open_pull_requests(repository: &Path) -> Result<HashMap<String, OpenPullRequest>, String> {
    let output = run_required(
        "gh",
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "200",
            "--json",
            "number,headRefName,baseRefName,body",
        ],
        repository,
    )?;
    let values = serde_json::from_str::<Vec<Value>>(&output)
        .map_err(|error| format!("GitHub CLI returned invalid pull-request data: {error}"))?;
    Ok(values
        .into_iter()
        .filter_map(|value| {
            Some((
                value.get("headRefName")?.as_str()?.to_string(),
                OpenPullRequest {
                    number: value.get("number")?.as_u64()?,
                    base: value.get("baseRefName")?.as_str()?.to_string(),
                    body: value
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                },
            ))
        })
        .collect())
}

fn create_pull_request(
    repository: &Path,
    branch: &str,
    base: Option<&str>,
    draft: bool,
) -> Result<u64, String> {
    let title = run_required("git", &["log", "-1", "--format=%s", branch], repository)?;
    let title = if title.trim().is_empty() {
        branch.to_string()
    } else {
        title
    };
    let mut arguments = vec![
        "pr",
        "create",
        "--head",
        branch,
        "--title",
        title.as_str(),
        "--body",
        "",
    ];
    if let Some(base) = base {
        arguments.extend(["--base", base]);
    }
    if draft {
        arguments.push("--draft");
    }
    let output = run_required("gh", &arguments, repository)?;
    output
        .lines()
        .rev()
        .find_map(|line| line.trim().rsplit_once("/pull/")?.1.parse().ok())
        .ok_or_else(|| format!("GitHub CLI did not report the pull request for `{branch}`."))
}

pub(super) fn with_stack_section(body: &str, stack: &[(String, u64)], current: u64) -> String {
    let lines = stack
        .iter()
        .map(|(branch, number)| {
            if *number == current {
                format!("- **#{number}** `{branch}` ← this pull request")
            } else {
                format!("- #{number} `{branch}`")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let section = format!("{STACK_SECTION_START}\n**Stack**\n\n{lines}\n{STACK_SECTION_END}");
    let start = body.find(STACK_SECTION_START);
    let end = body.find(STACK_SECTION_END);
    match (start, end) {
        (Some(start), Some(end)) if end > start => format!(
            "{}{section}{}",
            &body[..start],
            &body[end + STACK_SECTION_END.len()..]
        ),
        _ if body.trim().is_empty() => section,
        _ => format!("{}\n\n{section}", body.trim_end()),
    }
}

pub(super) fn submit_pull_requests(repository: &Path, draft: bool) -> Result<(), String> {
    let current = current_branch(repository)?;
    let parents = existing_parents(repository)?;
    let mut branches = stack_ancestors(&parents, &current);
    branches.extend(stack_descendants(&parents, &current));
    if branches.is_empty() {
        branches.push(current);
    }
    let remote = push_remote(repository)?;
    let existing = open_pull_requests(repository)?;
    let mut submitted = Vec::new();
    for branch in &branches {
        run_required(
            "git",
            &[
                "push",
                "--force-with-lease",
                "--set-upstream",
                &remote,
                branch,
            ],
            repository,
        )?;
        let base = parents.get(branch).map(String::as_str);
        let number = match existing.get(branch) {
            Some(pull_request) => {
                if let Some(base) = base.filter(|base| *base != pull_request.base) {
                    run_required(
                        "gh",
                        &[
                            "pr",
                            "edit",
                            &pull_request.number.to_string(),
                            "--base",
                            base,
                        ],
                        repository,
                    )?;
                }
                pull_request.number
            }
            None => create_pull_request(repository, branch, base, draft)?,
        };
        submitted.push((branch.clone(), number));
    }
    if submitted.len() > 1 {
        for (branch, number) in &submitted {
            let body = existing
                .get(branch)
                .map(|pull_request| pull_request.body.as_str())
                .unwrap_or_default();
            let updated = with_stack_section(body, &submitted, *number);
            if updated != body {
                run_required(
                    "gh",
                    &["pr", "edit", &number.to_string(), "--body", &updated],
                    repository,
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parents(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(branch, parent)| (branch.to_string(), parent.to_string()))
            .collect()
    }

    #[test]
    fn walks_stack_trees_and_rejects_cycles() {
        let tree = parents(&[("a", "main"), ("b", "a"), ("c", "b"), ("d", "a")]);
        assert_eq!(stack_descendants(&tree, "main"), vec!["a", "b", "d", "c"]);
        assert_eq!(stack_ancestors(&tree, "c"), vec!["a", "b", "c"]);
        assert_eq!(stack_trunk(&tree, "c"), "main");
        assert!(would_cycle(&tree, "a", "c"));
        assert!(!would_cycle(&tree, "d", "b"));
    }

    #[test]
    fn replaces_or_appends_the_stack_section() {
        let stack = vec![("a".to_string(), 1), ("b".to_string(), 2)];
        let fresh = with_stack_section("", &stack, 2);
        assert!(fresh.starts_with(STACK_SECTION_START));
        assert!(fresh.contains("- #1 `a`"));
        assert!(fresh.contains("- **#2** `b` ← this pull request"));

        let appended = with_stack_section("Adds the API.", &stack, 1);
        assert!(appended.starts_with("Adds the API.\n\n<!-- machdoch-stack -->"));

        let replaced = with_stack_section(
            &format!("Intro\n\n{STACK_SECTION_START}\nold\n{STACK_SECTION_END}\nOutro"),
            &stack,
            1,
        );
        assert!(replaced.starts_with("Intro\n\n<!-- machdoch-stack -->"));
        assert!(replaced.ends_with("<!-- /machdoch-stack -->\nOutro"));
        assert!(!replaced.contains("old"));
    }
}
