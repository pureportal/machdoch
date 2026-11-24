use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
    thread,
};

use serde::Serialize;

use super::{
    branch_alignment, config, git_directories, parse_branches, refs, repository_context,
    run_optional, run_required, stack, WorkspaceGitBranch, WorkspaceGitRepositoryRequest,
    BRANCH_REFERENCE_FORMAT,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBranchList {
    repository_root: String,
    current_branch: String,
    detached: bool,
    pub(super) local_branches: Vec<WorkspaceGitBranch>,
    pub(super) remote_branches: Vec<WorkspaceGitBranch>,
    recent_branches: Vec<String>,
}

type BranchCache = HashMap<PathBuf, (u64, Arc<WorkspaceGitBranchList>)>;

static CACHE: OnceLock<Mutex<BranchCache>> = OnceLock::new();

fn cache() -> MutexGuard<'static, BranchCache> {
    CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
pub(super) fn clear() {
    cache().clear();
}

fn metadata_key(path: &Path, hasher: &mut DefaultHasher) {
    fs::metadata(path)
        .ok()
        .map(|metadata| (metadata.len(), metadata.modified().ok()))
        .hash(hasher);
}

fn references_key(repository: &Path) -> Option<u64> {
    let generations = crate::workspace_watch::repository_generations(repository)?;
    let directories = git_directories(repository)?;
    let mut hasher = DefaultHasher::new();
    generations.refs.hash(&mut hasher);
    let head = fs::read(directories.git_dir.join("HEAD")).unwrap_or_default();
    head.hash(&mut hasher);
    if let Some(reference) = head
        .strip_prefix(b"ref:")
        .and_then(|reference| std::str::from_utf8(reference).ok())
    {
        fs::read(directories.common_dir.join(reference.trim()))
            .unwrap_or_default()
            .hash(&mut hasher);
    }
    metadata_key(&directories.common_dir.join("packed-refs"), &mut hasher);
    metadata_key(&directories.common_dir.join("config"), &mut hasher);
    metadata_key(&directories.git_dir.join("logs").join("HEAD"), &mut hasher);
    Some(hasher.finish())
}

fn current_head(repository: &Path) -> Option<String> {
    let directories = git_directories(repository)?;
    fs::read_to_string(directories.git_dir.join("HEAD"))
        .ok()?
        .trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_string)
}

fn merged_branches(repository: &Path, default_branch: Option<&str>) -> HashSet<String> {
    let Some(default_branch) = default_branch else {
        return HashSet::new();
    };
    run_optional(
        "git",
        &[
            "for-each-ref",
            &format!("--merged=refs/heads/{default_branch}"),
            "--format=%(refname:lstrip=2)",
            "refs/heads",
        ],
        repository,
    )
    .map(|output| {
        output
            .lines()
            .filter(|name| *name != default_branch)
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

fn read_branch_list(repository: &Path) -> Result<WorkspaceGitBranchList, String> {
    let head = current_head(repository);
    let default_branch =
        branch_alignment::default_branch(&refs::trunk_references(repository), head.as_deref());
    let (output, merged) = thread::scope(|scope| {
        let merged = scope.spawn(|| merged_branches(repository, default_branch.as_deref()));
        let output = run_required(
            "git",
            &[
                "for-each-ref",
                BRANCH_REFERENCE_FORMAT,
                "refs/heads",
                "refs/remotes",
            ],
            repository,
        );
        (output, merged.join().unwrap_or_default())
    });
    let output = output?;
    let mut local = parse_branches(&output, false);
    if let Some(head) = head.as_deref() {
        if !local.iter().any(|branch| branch.name == head) {
            local.insert(0, WorkspaceGitBranch::unborn(head));
        }
    }
    for branch in &mut local {
        branch.merged = Some(merged.contains(&branch.name));
    }
    let parents = config::read_repository_config(repository).parents;
    stack::annotate_branches(repository, &parents, &mut local);
    let local_names = local
        .iter()
        .map(|branch| branch.name.as_str())
        .collect::<HashSet<_>>();
    let recent_branches = refs::recent_branches(repository)
        .into_iter()
        .filter(|name| local_names.contains(name.as_str()))
        .collect();
    Ok(WorkspaceGitBranchList {
        repository_root: repository.display().to_string(),
        current_branch: head.clone().unwrap_or_else(|| "Detached HEAD".to_string()),
        detached: head.is_none(),
        local_branches: local,
        remote_branches: parse_branches(&output, true),
        recent_branches,
    })
}

pub(super) fn branch_list(repository: &Path) -> Result<Arc<WorkspaceGitBranchList>, String> {
    let key = references_key(repository);
    if let Some(key) = key {
        if let Some((cached_key, list)) = cache().get(repository) {
            if *cached_key == key {
                return Ok(Arc::clone(list));
            }
        }
    }
    let list = Arc::new(read_branch_list(repository)?);
    if let Some(key) = key {
        cache().insert(repository.to_path_buf(), (key, Arc::clone(&list)));
    }
    Ok(list)
}

pub(super) fn load_branch_list(
    request: WorkspaceGitRepositoryRequest,
) -> Result<WorkspaceGitBranchList, String> {
    let (workspace, repository) =
        repository_context(&request.workspace_root, &request.repository_root)?;
    crate::workspace_watch::ensure_watching(&workspace);
    branch_list(&repository).map(|list| list.as_ref().clone())
}
