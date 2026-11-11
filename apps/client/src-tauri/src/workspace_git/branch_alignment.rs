use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    thread,
};

use serde::{Deserialize, Serialize};

use super::{
    canonical_workspace_root, command_output, current_operation, discover_repositories,
    output_error, parallel_map, relative_workspace_path, repository_context, run_git_network,
    run_git_read, run_optional, run_required, summary::read_summary, WorkspaceGitRepository,
    FETCH_ARGUMENTS, MAX_CONCURRENT_REPOSITORY_INSPECTIONS,
};

const MAX_SUGGESTED_BRANCHES: usize = 300;
const MAX_SWITCH_TARGETS: usize = 256;
const DEFAULT_BRANCH_CANDIDATES: [&str; 2] = ["main", "master"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitBranchStatusRequest {
    workspace_root: String,
    branch_name: Option<String>,
    fetch: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBranchRepository {
    repository_root: String,
    relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_branch: Option<String>,
    branch_local: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_remote: Option<String>,
    changes: usize,
    conflicts: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBranchStatus {
    workspace_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_name: Option<String>,
    repositories: Vec<WorkspaceGitBranchRepository>,
    branches: Vec<String>,
    scan_limited: bool,
    issues: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitBranchSwitchTarget {
    repository_root: String,
    branch_name: String,
    #[serde(default)]
    create: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitBranchSwitchRequest {
    workspace_root: String,
    targets: Vec<WorkspaceGitBranchSwitchTarget>,
    stash_changes: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBranchSwitchResult {
    repository_root: String,
    relative_path: String,
    branch_name: String,
    switched: bool,
    stashed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct BranchReferences {
    local: HashSet<String>,
    remote: Vec<String>,
    remote_heads: Vec<(String, String)>,
    recent: Vec<(String, i64)>,
}

#[derive(Debug)]
struct RepositoryFacts {
    current_branch: Option<String>,
    changes: usize,
    conflicts: usize,
    operation: Option<String>,
    references: BranchReferences,
}

fn parse_references(output: &str) -> BranchReferences {
    references_from(output.lines().map(|line| {
        let mut parts = line.split('\t');
        let name = parts.next().unwrap_or_default();
        let symbolic_target = parts.next().unwrap_or_default();
        let committed_at = parts
            .next()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or_default();
        (name, symbolic_target, committed_at)
    }))
}

pub(super) fn references_from<'a>(
    entries: impl IntoIterator<Item = (&'a str, &'a str, i64)>,
) -> BranchReferences {
    let mut references = BranchReferences::default();
    for (name, symbolic_target, committed_at) in entries {
        if name.is_empty() {
            continue;
        }
        if let Some(branch) = name.strip_prefix("refs/heads/") {
            references.local.insert(branch.to_string());
            references.recent.push((branch.to_string(), committed_at));
            continue;
        }
        let Some(remote_branch) = name.strip_prefix("refs/remotes/") else {
            continue;
        };
        if let Some(remote) = remote_branch.strip_suffix("/HEAD") {
            if let Some(target) = symbolic_target
                .strip_prefix("refs/remotes/")
                .and_then(|target| target.strip_prefix(remote))
                .and_then(|target| target.strip_prefix('/'))
            {
                references
                    .remote_heads
                    .push((remote.to_string(), target.to_string()));
            }
            continue;
        }
        if let Some((_, branch)) = remote_branch.split_once('/') {
            references.recent.push((branch.to_string(), committed_at));
        }
        references.remote.push(remote_branch.to_string());
    }
    references
}

fn remote_branch_name<'a>(remote_branch: &'a str, branch: &str) -> Option<&'a str> {
    remote_branch
        .strip_suffix(branch)
        .and_then(|remote| remote.strip_suffix('/'))
        .filter(|remote| !remote.is_empty() && !remote.contains('/'))
}

fn preferred_remote_branch(references: &BranchReferences, branch: &str) -> Option<String> {
    references
        .remote
        .iter()
        .filter_map(|remote_branch| {
            remote_branch_name(remote_branch, branch).map(|remote| (remote, remote_branch))
        })
        .min_by_key(|(remote, _)| (*remote != "origin", remote.to_string()))
        .map(|(_, remote_branch)| remote_branch.clone())
}

pub(super) fn default_branch(
    references: &BranchReferences,
    current_branch: Option<&str>,
) -> Option<String> {
    if let Some((_, branch)) = references
        .remote_heads
        .iter()
        .min_by_key(|(remote, _)| (remote != "origin", remote.clone()))
    {
        return Some(branch.clone());
    }
    DEFAULT_BRANCH_CANDIDATES
        .iter()
        .find(|candidate| {
            references.local.contains(**candidate)
                || current_branch == Some(**candidate)
                || preferred_remote_branch(references, candidate).is_some()
        })
        .map(|candidate| candidate.to_string())
}

pub(super) fn read_trunk_references(repository: &Path) -> BranchReferences {
    run_optional(
        "git",
        &[
            "for-each-ref",
            "--format=%(refname)%09%(symref)%09%(committerdate:unix)",
            "refs/remotes/*/HEAD",
            "refs/remotes/*/main",
            "refs/remotes/*/master",
            "refs/heads/main",
            "refs/heads/master",
        ],
        repository,
    )
    .map(|output| parse_references(&output))
    .unwrap_or_default()
}

const BRANCH_REFERENCE_ARGUMENTS: [&str; 4] = [
    "for-each-ref",
    "--format=%(refname)%09%(symref)%09%(committerdate:unix)",
    "refs/heads",
    "refs/remotes",
];

pub(super) fn read_branch_references(repository: &Path) -> Result<BranchReferences, String> {
    run_required("git", &BRANCH_REFERENCE_ARGUMENTS, repository)
        .map(|output| parse_references(&output))
}

pub(super) fn branch_revision(references: &BranchReferences, branch: &str) -> Option<String> {
    if references.local.contains(branch) {
        return Some(format!("refs/heads/{branch}"));
    }
    preferred_remote_branch(references, branch)
        .map(|remote_branch| format!("refs/remotes/{remote_branch}"))
}

fn read_repository_facts(repository: &Path) -> Result<RepositoryFacts, String> {
    thread::scope(|scope| {
        let summary_worker = scope.spawn(|| read_summary(repository));
        let references_worker =
            scope.spawn(|| run_required("git", &BRANCH_REFERENCE_ARGUMENTS, repository));
        let operation = current_operation(repository);
        let summary = summary_worker
            .join()
            .map_err(|_| "Git status worker stopped unexpectedly.".to_string())??
            .ok_or_else(|| "The folder is no longer a Git repository.".to_string())?;
        let references = parse_references(
            &references_worker
                .join()
                .map_err(|_| "Git branch worker stopped unexpectedly.".to_string())??,
        );
        Ok(RepositoryFacts {
            current_branch: (!summary.detached).then_some(summary.branch),
            changes: summary.changes,
            conflicts: summary.conflicts,
            operation,
            references,
        })
    })
}

fn branch_status_repository(
    repository: &WorkspaceGitRepository,
    branch_name: Option<&str>,
) -> (WorkspaceGitBranchRepository, Vec<(String, i64)>) {
    let root = Path::new(&repository.repository_root);
    let mut status = WorkspaceGitBranchRepository {
        repository_root: repository.repository_root.clone(),
        relative_path: repository.relative_path.clone(),
        current_branch: None,
        default_branch: None,
        branch_local: false,
        branch_remote: None,
        changes: 0,
        conflicts: 0,
        operation: None,
        error: None,
    };
    match read_repository_facts(root) {
        Ok(facts) => {
            status.default_branch =
                default_branch(&facts.references, facts.current_branch.as_deref());
            if let Some(branch) = branch_name {
                status.branch_local = facts.references.local.contains(branch);
                status.branch_remote = preferred_remote_branch(&facts.references, branch);
            }
            status.current_branch = facts.current_branch;
            status.changes = facts.changes;
            status.conflicts = facts.conflicts;
            status.operation = facts.operation;
            (status, facts.references.recent)
        }
        Err(error) => {
            status.error = Some(error);
            (status, Vec::new())
        }
    }
}

fn recent_branch_names(recent: impl IntoIterator<Item = (String, i64)>) -> Vec<String> {
    let mut latest: HashMap<String, i64> = HashMap::new();
    for (branch, committed_at) in recent {
        if branch == "HEAD" {
            continue;
        }
        let entry = latest.entry(branch).or_insert(committed_at);
        *entry = (*entry).max(committed_at);
    }
    let mut branches = latest.into_iter().collect::<Vec<_>>();
    branches.sort_by(|(left, left_at), (right, right_at)| {
        right_at.cmp(left_at).then_with(|| left.cmp(right))
    });
    branches
        .into_iter()
        .take(MAX_SUGGESTED_BRANCHES)
        .map(|(branch, _)| branch)
        .collect()
}

fn normalized_branch_query(branch_name: Option<&str>) -> Result<Option<String>, String> {
    let Some(branch) = branch_name
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
    else {
        return Ok(None);
    };
    if branch.chars().count() > 255 || branch.chars().any(char::is_control) {
        return Err("Enter a valid branch name.".to_string());
    }
    Ok(Some(branch.to_string()))
}

fn fetch_repositories(workspace_root: &str) -> Result<Vec<String>, String> {
    let discovery = discover_repositories(workspace_root, false)?;
    Ok(parallel_map(
        &discovery.repositories,
        MAX_CONCURRENT_REPOSITORY_INSPECTIONS,
        |repository| {
            run_required(
                "git",
                &FETCH_ARGUMENTS,
                Path::new(&repository.repository_root),
            )
            .err()
            .map(|error| format!("Could not fetch {}: {error}", repository.relative_path))
        },
    )
    .into_iter()
    .flatten()
    .collect())
}

pub(super) async fn load_branch_status(
    request: WorkspaceGitBranchStatusRequest,
) -> Result<WorkspaceGitBranchStatus, String> {
    let branch_name = normalized_branch_query(request.branch_name.as_deref())?;
    let workspace_root = request.workspace_root;
    let fetch_issues = if request.fetch == Some(true) {
        let fetch_root = workspace_root.clone();
        run_git_network(move || fetch_repositories(&fetch_root)).await?
    } else {
        Vec::new()
    };
    run_git_read(move || read_branch_status(&workspace_root, branch_name, fetch_issues)).await
}

fn read_branch_status(
    workspace_root: &str,
    branch_name: Option<String>,
    fetch_issues: Vec<String>,
) -> Result<WorkspaceGitBranchStatus, String> {
    let discovery = discover_repositories(workspace_root, false)?;
    let mut issues = discovery.issues;
    issues.extend(fetch_issues);
    let mut repositories = Vec::with_capacity(discovery.repositories.len());
    let mut recent = Vec::new();
    for (status, branches) in parallel_map(
        &discovery.repositories,
        MAX_CONCURRENT_REPOSITORY_INSPECTIONS,
        |repository| branch_status_repository(repository, branch_name.as_deref()),
    ) {
        repositories.push(status);
        recent.extend(branches);
    }
    Ok(WorkspaceGitBranchStatus {
        workspace_root: discovery.workspace_root,
        branch_name,
        repositories,
        branches: recent_branch_names(recent),
        scan_limited: discovery.scan_limited,
        issues,
    })
}

#[derive(Debug, PartialEq, Eq)]
enum SwitchSource {
    Current,
    Local,
    Remote(String),
    Create,
}

#[derive(Debug)]
struct PreparedSwitch {
    repository: PathBuf,
    relative_path: String,
    branch_name: String,
    source: SwitchSource,
    stash: bool,
}

fn validate_switch_branch(branch_name: &str, repository: &Path) -> Result<String, String> {
    let branch = branch_name.trim();
    if branch.is_empty()
        || branch == "HEAD"
        || branch.starts_with('-')
        || branch.chars().count() > 255
        || branch.chars().any(char::is_control)
    {
        return Err("Enter a valid branch name.".to_string());
    }
    run_required(
        "git",
        &["check-ref-format", &format!("refs/heads/{branch}")],
        repository,
    )
    .map_err(|_| "Enter a valid branch name.".to_string())?;
    Ok(branch.to_string())
}

fn repository_display_name(workspace: &Path, relative_path: &str) -> String {
    if relative_path != "." {
        return relative_path.to_string();
    }
    workspace
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| workspace.display().to_string())
}

fn prepare_switch(
    workspace_root: &str,
    target: &WorkspaceGitBranchSwitchTarget,
    stash_changes: bool,
) -> Result<PreparedSwitch, String> {
    let (workspace, repository) = repository_context(workspace_root, &target.repository_root)?;
    let relative_path = relative_workspace_path(&workspace, &repository);
    let name = repository_display_name(&workspace, &relative_path);
    let (branch_name, facts) = thread::scope(|scope| {
        let facts_worker = scope.spawn(|| read_repository_facts(&repository));
        let branch_name = validate_switch_branch(&target.branch_name, &repository);
        let facts = facts_worker
            .join()
            .unwrap_or_else(|_| Err("Git status worker stopped unexpectedly.".to_string()));
        (branch_name, facts)
    });
    let branch_name = branch_name.map_err(|error| format!("{name}: {error}"))?;
    let facts = facts.map_err(|error| format!("{name}: {error}"))?;
    let source = if facts.current_branch.as_deref() == Some(branch_name.as_str()) {
        SwitchSource::Current
    } else if let Some(operation) = facts.operation.as_deref() {
        return Err(format!("Finish the {operation} in {name} first."));
    } else if facts.conflicts > 0 {
        return Err(format!("Resolve the conflicts in {name} first."));
    } else if facts.references.local.contains(&branch_name) {
        SwitchSource::Local
    } else if let Some(remote) = preferred_remote_branch(&facts.references, &branch_name) {
        SwitchSource::Remote(remote)
    } else if target.create {
        SwitchSource::Create
    } else {
        return Err(format!("Branch `{branch_name}` does not exist in {name}."));
    };
    let stash = stash_changes
        && facts.changes > 0
        && matches!(source, SwitchSource::Local | SwitchSource::Remote(_));
    Ok(PreparedSwitch {
        repository,
        relative_path,
        branch_name,
        source,
        stash,
    })
}

fn stash_reference(repository: &Path) -> Option<String> {
    run_optional(
        "git",
        &["rev-parse", "--quiet", "--verify", "refs/stash"],
        repository,
    )
    .filter(|reference| !reference.is_empty())
}

fn stash_worktree(repository: &Path, branch_name: &str) -> Result<bool, String> {
    let before = stash_reference(repository);
    let message = format!("Before switching to {branch_name}");
    // Stash builds internal pathspecs that literal pathspec mode would break.
    run_required(
        "git",
        &[
            "--no-literal-pathspecs",
            "stash",
            "push",
            "--include-untracked",
            "--message",
            &message,
        ],
        repository,
    )?;
    Ok(stash_reference(repository) != before)
}

fn switch_branch(prepared: &PreparedSwitch) -> Result<(), String> {
    let branch = prepared.branch_name.as_str();
    let arguments: Vec<&str> = match &prepared.source {
        SwitchSource::Current => return Ok(()),
        SwitchSource::Local => vec!["switch", "--no-guess", branch],
        SwitchSource::Remote(remote) => vec!["switch", "--track", remote.as_str()],
        SwitchSource::Create => vec!["switch", "--create", branch],
    };
    let output = command_output("git", &arguments, &prepared.repository)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(output_error("git", &arguments, &output))
    }
}

fn execute_switch(prepared: &PreparedSwitch) -> WorkspaceGitBranchSwitchResult {
    let mut result = WorkspaceGitBranchSwitchResult {
        repository_root: prepared.repository.display().to_string(),
        relative_path: prepared.relative_path.clone(),
        branch_name: prepared.branch_name.clone(),
        switched: false,
        stashed: false,
        error: None,
    };
    if prepared.source == SwitchSource::Current {
        return result;
    }
    if prepared.stash {
        match stash_worktree(&prepared.repository, &prepared.branch_name) {
            Ok(stashed) => result.stashed = stashed,
            Err(error) => {
                result.error = Some(error);
                return result;
            }
        }
    }
    match switch_branch(prepared) {
        Ok(()) => result.switched = true,
        Err(error) if result.stashed => {
            let restored = run_required(
                "git",
                &["--no-literal-pathspecs", "stash", "pop", "--index"],
                &prepared.repository,
            );
            result.stashed = restored.is_err();
            result.error = Some(match restored {
                Ok(_) => error,
                Err(_) => format!("{error} Your changes are still in the stash."),
            });
        }
        Err(error) => result.error = Some(error),
    }
    result
}

pub(super) fn switch_branches(
    request: WorkspaceGitBranchSwitchRequest,
) -> Result<Vec<WorkspaceGitBranchSwitchResult>, String> {
    let workspace = canonical_workspace_root(&request.workspace_root)?;
    if request.targets.is_empty() || request.targets.len() > MAX_SWITCH_TARGETS {
        return Err("Select between 1 and 256 repositories.".to_string());
    }
    let prepared = parallel_map(
        &request.targets,
        MAX_CONCURRENT_REPOSITORY_INSPECTIONS,
        |target| prepare_switch(&request.workspace_root, target, request.stash_changes),
    )
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    let mut seen = HashSet::new();
    if let Some(duplicate) = prepared
        .iter()
        .find(|switch| !seen.insert(switch.repository.clone()))
    {
        return Err(format!(
            "{} was selected more than once.",
            repository_display_name(&workspace, &duplicate.relative_path)
        ));
    }
    Ok(parallel_map(
        &prepared,
        MAX_CONCURRENT_REPOSITORY_INSPECTIONS,
        execute_switch,
    ))
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
        time::SystemTime,
    };

    use super::*;

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("the clock should be valid")
                .as_nanos();
            let root = env::temp_dir().join(format!(
                "machdoch-git-branch-alignment-{}-{unique}-{}-{name}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).expect("the fixture should be created");
            Self { root }
        }

        fn path(&self, relative: &str) -> PathBuf {
            if relative == "." {
                self.root.clone()
            } else {
                self.root.join(relative)
            }
        }

        fn git(&self, relative: &str, arguments: &[&str]) -> String {
            run_required("git", arguments, &self.path(relative))
                .unwrap_or_else(|error| panic!("git {arguments:?} failed: {error}"))
        }

        fn repository(&self, relative: &str) {
            fs::create_dir_all(self.path(relative)).expect("the repository should be created");
            self.git(relative, &["init", "-b", "main"]);
            self.git(relative, &["config", "user.email", "branch@example.test"]);
            self.git(relative, &["config", "user.name", "Branch"]);
            self.git(relative, &["config", "commit.gpgsign", "false"]);
            self.commit(relative, "readme.md", "base\n", "base");
        }

        fn clone_repository(&self, origin: &str, relative: &str) {
            self.git(
                ".",
                &[
                    "clone",
                    "--quiet",
                    &self.path(origin).display().to_string(),
                    relative,
                ],
            );
            self.git(relative, &["config", "user.email", "branch@example.test"]);
            self.git(relative, &["config", "user.name", "Branch"]);
            self.git(relative, &["config", "commit.gpgsign", "false"]);
        }

        fn write(&self, relative: &str, file: &str, content: &str) {
            fs::write(self.path(relative).join(file), content).expect("the file should write");
        }

        fn commit(&self, relative: &str, file: &str, content: &str, message: &str) {
            self.write(relative, file, content);
            self.git(relative, &["add", "--", file]);
            self.git(relative, &["commit", "--quiet", "-m", message]);
        }

        fn status(&self, branch_name: Option<&str>) -> WorkspaceGitBranchStatus {
            read_branch_status(
                &self.root.display().to_string(),
                branch_name.map(str::to_string),
                Vec::new(),
            )
            .expect("the branch status should load")
        }

        fn repository_status<'a>(
            status: &'a WorkspaceGitBranchStatus,
            relative: &str,
        ) -> &'a WorkspaceGitBranchRepository {
            status
                .repositories
                .iter()
                .find(|repository| repository.relative_path == relative)
                .unwrap_or_else(|| panic!("{relative} should be discovered"))
        }

        fn switch(
            &self,
            targets: &[(&str, &str, bool)],
            stash_changes: bool,
        ) -> Result<Vec<WorkspaceGitBranchSwitchResult>, String> {
            switch_branches(WorkspaceGitBranchSwitchRequest {
                workspace_root: self.root.display().to_string(),
                targets: targets
                    .iter()
                    .map(
                        |(relative, branch, create)| WorkspaceGitBranchSwitchTarget {
                            repository_root: self.path(relative).display().to_string(),
                            branch_name: branch.to_string(),
                            create: *create,
                        },
                    )
                    .collect(),
                stash_changes,
            })
        }

        fn current_branch(&self, relative: &str) -> String {
            self.git(relative, &["branch", "--show-current"])
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn parses_local_remote_and_default_references() {
        let references = parse_references(
            "refs/heads/main\t\t30\nrefs/heads/feature/a\t\t40\nrefs/remotes/origin/HEAD\trefs/remotes/origin/develop\t0\nrefs/remotes/origin/develop\t\t10\nrefs/remotes/origin/feature/b\t\t50\nrefs/remotes/fork/feature/b\t\t20\n",
        );
        assert!(references.local.contains("feature/a"));
        assert_eq!(
            preferred_remote_branch(&references, "feature/b").as_deref(),
            Some("origin/feature/b")
        );
        assert_eq!(preferred_remote_branch(&references, "b"), None);
        assert_eq!(
            default_branch(&references, None).as_deref(),
            Some("develop")
        );
        assert_eq!(
            recent_branch_names(references.recent),
            vec!["feature/b", "feature/a", "main", "develop"]
        );
    }

    #[test]
    fn falls_back_to_conventional_default_branches() {
        let references = parse_references("refs/heads/master\t\t1\nrefs/heads/topic\t\t2\n");
        assert_eq!(default_branch(&references, None).as_deref(), Some("master"));
        let unborn = parse_references("");
        assert_eq!(
            default_branch(&unborn, Some("main")).as_deref(),
            Some("main")
        );
        assert_eq!(default_branch(&unborn, Some("trunk")), None);
    }

    #[test]
    fn reports_branch_facts_for_every_repository() {
        let fixture = Fixture::new("status");
        fixture.repository("origin-api");
        fixture.git("origin-api", &["branch", "feature/ticket"]);
        fixture.clone_repository("origin-api", "api");
        fixture.repository("ui");
        fixture.git("ui", &["switch", "--quiet", "-c", "feature/ticket"]);
        fixture.repository("tools");
        fixture.git("tools", &["switch", "--quiet", "-c", "feature/other"]);
        fixture.write("tools", "draft.txt", "draft\n");

        let status = fixture.status(Some("feature/ticket"));
        let api = Fixture::repository_status(&status, "api");
        assert_eq!(api.current_branch.as_deref(), Some("main"));
        assert_eq!(api.default_branch.as_deref(), Some("main"));
        assert!(!api.branch_local);
        assert_eq!(api.branch_remote.as_deref(), Some("origin/feature/ticket"));
        let ui = Fixture::repository_status(&status, "ui");
        assert_eq!(ui.current_branch.as_deref(), Some("feature/ticket"));
        assert!(ui.branch_local);
        let tools = Fixture::repository_status(&status, "tools");
        assert_eq!(tools.current_branch.as_deref(), Some("feature/other"));
        assert!(!tools.branch_local);
        assert_eq!(tools.branch_remote, None);
        assert_eq!(tools.changes, 1);
        assert!(status.branches.contains(&"feature/ticket".to_string()));
        assert!(status.branches.contains(&"feature/other".to_string()));

        let unassigned = fixture.status(None);
        assert_eq!(unassigned.branch_name, None);
        assert!(unassigned
            .repositories
            .iter()
            .all(|repository| !repository.branch_local && repository.branch_remote.is_none()));
    }

    #[test]
    fn switches_local_remote_and_new_branches() {
        let fixture = Fixture::new("switch");
        fixture.repository("origin-api");
        fixture.git("origin-api", &["branch", "feature/ticket"]);
        fixture.clone_repository("origin-api", "api");
        fixture.repository("ui");
        fixture.git("ui", &["branch", "feature/ticket"]);
        fixture.repository("docs");

        let results = fixture
            .switch(
                &[
                    ("api", "feature/ticket", false),
                    ("ui", "feature/ticket", false),
                    ("docs", "feature/ticket", true),
                ],
                false,
            )
            .expect("the switch should run");
        assert!(results
            .iter()
            .all(|result| result.switched && result.error.is_none()));
        assert_eq!(fixture.current_branch("api"), "feature/ticket");
        assert_eq!(
            fixture.git(
                "api",
                &["rev-parse", "--abbrev-ref", "feature/ticket@{upstream}"]
            ),
            "origin/feature/ticket"
        );
        assert_eq!(fixture.current_branch("ui"), "feature/ticket");
        assert_eq!(fixture.current_branch("docs"), "feature/ticket");

        let repeated = fixture
            .switch(&[("ui", "feature/ticket", false)], false)
            .expect("an aligned repository should be a no-op");
        assert!(!repeated[0].switched && repeated[0].error.is_none());
    }

    #[test]
    fn stashes_changes_and_carries_them_into_new_branches() {
        let fixture = Fixture::new("stash");
        fixture.repository("ui");
        fixture.git("ui", &["branch", "feature/ticket"]);
        fixture.write("ui", "readme.md", "edited\n");
        fixture.write("ui", "untracked.txt", "new\n");

        let results = fixture
            .switch(&[("ui", "feature/ticket", false)], true)
            .expect("the switch should run");
        assert!(results[0].switched && results[0].stashed);
        assert_eq!(fixture.current_branch("ui"), "feature/ticket");
        assert_eq!(fixture.git("ui", &["status", "--porcelain"]), "");
        assert!(fixture
            .git("ui", &["stash", "list", "--format=%gs"])
            .contains("On main: Before switching to feature/ticket"));

        fixture.repository("api");
        fixture.write("api", "readme.md", "started on main\n");
        let created = fixture
            .switch(&[("api", "feature/ticket", true)], true)
            .expect("the branch should be created");
        assert!(created[0].switched && !created[0].stashed);
        assert_eq!(fixture.current_branch("api"), "feature/ticket");
        assert_eq!(
            fixture.git("api", &["status", "--porcelain"]),
            "M readme.md"
        );
    }

    #[test]
    fn restores_stashed_changes_when_the_switch_fails() {
        let fixture = Fixture::new("restore");
        fixture.repository("ui");
        fixture.git("ui", &["branch", "feature/ticket"]);
        let worktree = fixture.path("ui-ticket").display().to_string();
        fixture.git(
            "ui",
            &["worktree", "add", "--quiet", &worktree, "feature/ticket"],
        );
        fixture.write("ui", "readme.md", "edited\n");

        let results = fixture
            .switch(&[("ui", "feature/ticket", false)], true)
            .expect("the switch should run");
        assert!(!results[0].switched);
        assert!(!results[0].stashed);
        assert!(results[0].error.is_some());
        assert_eq!(fixture.current_branch("ui"), "main");
        assert_eq!(fixture.git("ui", &["status", "--porcelain"]), "M readme.md");
        assert_eq!(fixture.git("ui", &["stash", "list"]), "");
    }

    #[test]
    fn refuses_unsafe_or_unknown_targets_before_changing_anything() {
        let fixture = Fixture::new("refuse");
        fixture.repository("ui");
        fixture.git("ui", &["branch", "feature/ticket"]);
        fixture.repository("api");

        let missing = fixture
            .switch(
                &[
                    ("ui", "feature/ticket", false),
                    ("api", "feature/ticket", false),
                ],
                false,
            )
            .expect_err("a missing branch should be refused");
        assert!(missing.contains("does not exist in api"));
        assert_eq!(fixture.current_branch("ui"), "main");

        for invalid in ["-x", "HEAD", "bad..name", "@{-1}"] {
            assert!(fixture.switch(&[("ui", invalid, true)], false).is_err());
        }
        assert!(fixture
            .switch(
                &[
                    ("ui", "feature/ticket", false),
                    ("ui", "feature/ticket", false)
                ],
                false
            )
            .is_err());

        fixture.git("ui", &["switch", "--quiet", "feature/ticket"]);
        fixture.commit("ui", "readme.md", "ticket\n", "ticket");
        fixture.git("ui", &["switch", "--quiet", "main"]);
        fixture.commit("ui", "readme.md", "main\n", "main");
        let _ = run_required("git", &["merge", "feature/ticket"], &fixture.path("ui"));
        fixture.git("ui", &["branch", "feature/next"]);
        let conflicted = fixture
            .switch(&[("ui", "feature/next", false)], true)
            .expect_err("a merge in progress should be refused");
        assert!(conflicted.contains("Finish the merge in ui first."));
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        let workspace = Fixture::new("workspace");
        let outside = Fixture::new("outside");
        outside.repository(".");
        let error = switch_branches(WorkspaceGitBranchSwitchRequest {
            workspace_root: workspace.root.display().to_string(),
            targets: vec![WorkspaceGitBranchSwitchTarget {
                repository_root: outside.root.display().to_string(),
                branch_name: "main".to_string(),
                create: false,
            }],
            stash_changes: false,
        })
        .expect_err("outside repositories should be refused");
        assert!(error.contains("outside this workspace"));
        assert!(Path::new(&outside.root).exists());
    }
}
