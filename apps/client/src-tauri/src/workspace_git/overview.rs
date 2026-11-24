use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;

use super::{
    branch_alignment, branches, config, current_operation, fsmonitor, git_directories,
    parse_commits, parse_numstat, parse_stashes, refs, repository_context, run_optional, status,
    worktree_status, worktrees, WorkspaceGitCommit, WorkspaceGitOverview, WorkspaceGitStash,
    MAX_GIT_ENTRIES, MAX_RECENT_COMMITS,
};

const MAX_NUMSTAT_PATH_CHARS: usize = 6_000;
const LINKED_WORKTREE_REFRESH_SECONDS: u64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum OverviewSection {
    Branches,
    Numstat,
    RecentCommits,
    Stashes,
    Worktrees,
}

impl OverviewSection {
    const ALL: [Self; 5] = [
        Self::Branches,
        Self::Numstat,
        Self::RecentCommits,
        Self::Stashes,
        Self::Worktrees,
    ];

    fn parse(value: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|section| section.as_str() == value)
            .ok_or_else(|| format!("Unknown Git overview section `{value}`."))
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Branches => "branches",
            Self::Numstat => "numstat",
            Self::RecentCommits => "recentCommits",
            Self::Stashes => "stashes",
            Self::Worktrees => "worktrees",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGitOverviewRequest {
    workspace_root: String,
    repository_root: String,
    sections: Option<Vec<String>>,
    untracked_files: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct OverviewOptions {
    sections: Vec<OverviewSection>,
    untracked: status::UntrackedFiles,
}

impl OverviewOptions {
    pub(super) fn full() -> Self {
        Self {
            sections: OverviewSection::ALL.to_vec(),
            untracked: status::UntrackedFiles::All,
        }
    }

    fn includes(&self, section: OverviewSection) -> bool {
        self.sections.contains(&section)
    }
}

impl OverviewOptions {
    pub(super) fn parse(
        sections: Option<&[String]>,
        untracked_files: Option<&str>,
    ) -> Result<Self, String> {
        Ok(Self {
            sections: sections
                .unwrap_or_default()
                .iter()
                .map(|section| OverviewSection::parse(section))
                .collect::<Result<_, _>>()?,
            untracked: status::UntrackedFiles::parse(untracked_files)?,
        })
    }
}

impl WorkspaceGitOverviewRequest {
    pub(super) fn options(&self) -> Result<OverviewOptions, String> {
        OverviewOptions::parse(self.sections.as_deref(), self.untracked_files.as_deref())
    }

    pub(super) fn roots(&self) -> (&str, &str) {
        (&self.workspace_root, &self.repository_root)
    }
}

#[derive(Clone)]
enum SectionValue {
    Commits(Arc<Vec<WorkspaceGitCommit>>),
    Stashes(Arc<Vec<WorkspaceGitStash>>),
    Worktrees(Arc<Vec<worktrees::WorkspaceGitWorktree>>),
    Numstat(Arc<HashMap<String, (Option<u64>, Option<u64>)>>),
}

type SectionCache = HashMap<(PathBuf, OverviewSection), (u64, SectionValue)>;

static SECTION_CACHE: OnceLock<Mutex<SectionCache>> = OnceLock::new();

fn section_cache() -> MutexGuard<'static, SectionCache> {
    SECTION_CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
pub(super) fn clear() {
    section_cache().clear();
}

fn metadata_key(path: &Path, hasher: &mut DefaultHasher) {
    fs::metadata(path)
        .ok()
        .map(|metadata| (metadata.len(), metadata.modified().ok()))
        .hash(hasher);
}

fn linked_worktrees_key(worktrees: &Path, hasher: &mut DefaultHasher) {
    let Ok(entries) = fs::read_dir(worktrees) else {
        return;
    };
    let mut linked = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    if linked.is_empty() {
        return;
    }
    linked.sort();
    for administrative in linked {
        metadata_key(&administrative.join("HEAD"), hasher);
        metadata_key(&administrative.join("index"), hasher);
        metadata_key(&administrative.join("locked"), hasher);
        let checkout = fs::read_to_string(administrative.join("gitdir")).unwrap_or_default();
        Path::new(checkout.trim()).exists().hash(hasher);
        checkout.hash(hasher);
    }
    (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
        / LINKED_WORKTREE_REFRESH_SECONDS)
        .hash(hasher);
}

fn section_key(
    repository: &Path,
    section: OverviewSection,
    repository_status: Option<&status::RepositoryStatus>,
) -> Option<u64> {
    let generations = crate::workspace_watch::repository_generations(repository)?;
    let directories = git_directories(repository)?;
    let mut hasher = DefaultHasher::new();
    match section {
        OverviewSection::Branches => return None,
        OverviewSection::RecentCommits => repository_status?.branch.oid.hash(&mut hasher),
        OverviewSection::Stashes => {
            metadata_key(
                &directories
                    .common_dir
                    .join("logs")
                    .join("refs")
                    .join("stash"),
                &mut hasher,
            );
        }
        OverviewSection::Worktrees => {
            generations.refs.hash(&mut hasher);
            generations.worktree.hash(&mut hasher);
            linked_worktrees_key(&directories.common_dir.join("worktrees"), &mut hasher);
        }
        OverviewSection::Numstat => {
            let repository_status = repository_status?;
            generations.worktree.hash(&mut hasher);
            repository_status.branch.oid.hash(&mut hasher);
            for entry in tracked_entries(repository_status) {
                entry.path.hash(&mut hasher);
                entry.original_path.hash(&mut hasher);
            }
        }
    }
    Some(hasher.finish())
}

fn join_section(
    worker: thread::ScopedJoinHandle<'_, Result<SectionValue, String>>,
) -> Result<SectionValue, String> {
    worker
        .join()
        .map_err(|_| "A Git overview worker stopped unexpectedly.".to_string())?
}

fn cached_section(
    repository: &Path,
    section: OverviewSection,
    repository_status: Option<&status::RepositoryStatus>,
    load: impl FnOnce() -> Result<SectionValue, String>,
) -> Result<SectionValue, String> {
    let key = section_key(repository, section, repository_status);
    if let Some(key) = key {
        if let Some((cached_key, value)) = section_cache().get(&(repository.to_path_buf(), section))
        {
            if *cached_key == key {
                return Ok(value.clone());
            }
        }
    }
    let value = load()?;
    if let Some(key) = key {
        section_cache().insert((repository.to_path_buf(), section), (key, value.clone()));
    }
    Ok(value)
}

fn load_recent_commits(repository: &Path) -> Vec<WorkspaceGitCommit> {
    run_optional(
        "git",
        &[
            "log",
            &format!("-{MAX_RECENT_COMMITS}"),
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI",
        ],
        repository,
    )
    .map(|output| parse_commits(&output))
    .unwrap_or_default()
}

fn load_stashes(repository: &Path) -> Vec<WorkspaceGitStash> {
    run_optional(
        "git",
        &["stash", "list", "--format=%gd%x1f%gs%x1f%cI"],
        repository,
    )
    .map(|output| parse_stashes(&output))
    .unwrap_or_default()
}

fn tracked_entries(
    repository_status: &status::RepositoryStatus,
) -> impl Iterator<Item = &status::StatusEntry> {
    repository_status
        .entries
        .iter()
        .filter(|entry| !entry.untracked)
        .take(MAX_GIT_ENTRIES)
}

fn path_batches<'a>(paths: impl Iterator<Item = &'a str>) -> Vec<Vec<&'a str>> {
    let mut batches: Vec<Vec<&str>> = Vec::new();
    let mut characters = 0;
    for path in paths {
        if batches.is_empty() || characters + path.len() > MAX_NUMSTAT_PATH_CHARS {
            batches.push(Vec::new());
            characters = 0;
        }
        characters += path.len() + 1;
        batches.last_mut().expect("a batch exists").push(path);
    }
    batches
}

fn load_numstat(
    repository: &Path,
    repository_status: &status::RepositoryStatus,
    has_head: bool,
) -> HashMap<String, (Option<u64>, Option<u64>)> {
    if !has_head {
        return HashMap::new();
    }
    let (submodules, files): (Vec<_>, Vec<_>) =
        tracked_entries(repository_status).partition(|entry| entry.submodule);
    let tracked = files
        .into_iter()
        .flat_map(|entry| {
            std::iter::once(entry.path.as_str()).chain(entry.original_path.as_deref())
        })
        .collect::<Vec<_>>();
    let mut counts = worktree_status::head_numstat(repository, &tracked);
    counts.extend(submodules.into_iter().map(|entry| {
        let lines = match entry.code {
            [b'A', _] => (Some(1), Some(0)),
            [b'D', _] | [_, b'D'] => (Some(0), Some(1)),
            _ => (Some(1), Some(1)),
        };
        (entry.path.clone(), lines)
    }));
    let batches = path_batches(
        tracked
            .into_iter()
            .filter(|path| !counts.contains_key(*path)),
    );
    let remaining = thread::scope(|scope| {
        batches
            .iter()
            .map(|batch| {
                scope.spawn(move || {
                    let mut arguments = vec![
                        "diff",
                        "HEAD",
                        "--numstat",
                        "-z",
                        "--ignore-submodules=dirty",
                        "--no-renames",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--",
                    ];
                    arguments.extend(batch.iter().copied());
                    run_optional("git", &arguments, repository)
                        .map(|output| parse_numstat(&output))
                        .unwrap_or_default()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect::<Vec<_>>()
    });
    counts.extend(remaining);
    counts
}

pub(super) fn last_fetched_at(repository: &Path) -> Option<u64> {
    let directories = git_directories(repository)?;
    fs::metadata(directories.git_dir.join("FETCH_HEAD"))
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
}

pub(super) fn load_overview(
    workspace_root: &str,
    repository_root: &str,
    options: &OverviewOptions,
) -> Result<WorkspaceGitOverview, String> {
    let (workspace, repository) = repository_context(workspace_root, repository_root)?;
    crate::workspace_watch::ensure_watching(&workspace);
    let fsmonitor = fsmonitor::enabled_for(&workspace);
    let (repository_status, branches, numstat, commits, stashes, worktrees) =
        thread::scope(|scope| {
            let branches = options
                .includes(OverviewSection::Branches)
                .then(|| scope.spawn(|| branches::branch_list(&repository)));
            let worktrees = options.includes(OverviewSection::Worktrees).then(|| {
                scope.spawn(|| {
                    cached_section(&repository, OverviewSection::Worktrees, None, || {
                        Ok(SectionValue::Worktrees(Arc::new(
                            worktrees::read_worktrees(&repository),
                        )))
                    })
                })
            });
            let prefetched_commits = (options.includes(OverviewSection::RecentCommits)
                && !section_cache()
                    .contains_key(&(repository.to_path_buf(), OverviewSection::RecentCommits)))
            .then(|| scope.spawn(|| load_recent_commits(&repository)));
            let repository_status =
                status::repository_status(&repository, options.untracked, fsmonitor)?;
            let has_head = repository_status.branch.oid.is_some();
            let (numstat, stashes, commits) = thread::scope(|status_scope| {
                let numstat = options.includes(OverviewSection::Numstat).then(|| {
                    status_scope.spawn(|| {
                        cached_section(
                            &repository,
                            OverviewSection::Numstat,
                            Some(&repository_status),
                            || {
                                Ok(SectionValue::Numstat(Arc::new(load_numstat(
                                    &repository,
                                    &repository_status,
                                    has_head,
                                ))))
                            },
                        )
                    })
                });
                let stashes = (options.includes(OverviewSection::Stashes)
                    && repository_status.stash_count > 0)
                    .then(|| {
                        status_scope.spawn(|| {
                            cached_section(
                                &repository,
                                OverviewSection::Stashes,
                                Some(&repository_status),
                                || Ok(SectionValue::Stashes(Arc::new(load_stashes(&repository)))),
                            )
                        })
                    });
                let commits = (options.includes(OverviewSection::RecentCommits) && has_head)
                    .then(|| {
                        cached_section(
                            &repository,
                            OverviewSection::RecentCommits,
                            Some(&repository_status),
                            || {
                                let commits = match prefetched_commits {
                                    Some(worker) => worker.join().map_err(|_| {
                                        "A Git overview worker stopped unexpectedly.".to_string()
                                    })?,
                                    None => load_recent_commits(&repository),
                                };
                                Ok(SectionValue::Commits(Arc::new(commits)))
                            },
                        )
                    })
                    .transpose()?;
                Ok::<_, String>((
                    numstat.map(join_section).transpose()?,
                    stashes.map(join_section).transpose()?,
                    commits,
                ))
            })?;
            let branches = branches
                .map(|worker| {
                    worker
                        .join()
                        .map_err(|_| "The Git branch worker stopped unexpectedly.".to_string())?
                })
                .transpose()?;
            Ok::<_, String>((
                repository_status,
                branches,
                numstat,
                commits,
                stashes,
                worktrees.map(join_section).transpose()?,
            ))
        })?;
    let head = repository_status.branch.head.clone();
    let (local_branches, remote_branches) = branches
        .map(|list| (list.local_branches.clone(), list.remote_branches.clone()))
        .unwrap_or_default();
    let default_branch =
        branch_alignment::default_branch(&refs::trunk_references(&repository), head.as_deref());
    let counts = repository_status.counts();
    let (mut changes, changes_truncated) = repository_status.changes(MAX_GIT_ENTRIES);
    if let Some(SectionValue::Numstat(numstat)) = numstat.as_ref() {
        for change in &mut changes {
            if let Some((additions, deletions)) = numstat.get(&change.path) {
                change.additions = *additions;
                change.deletions = *deletions;
            }
        }
    }
    let branch = &repository_status.branch;
    Ok(WorkspaceGitOverview {
        workspace_root: workspace.display().to_string(),
        repository_root: repository.display().to_string(),
        branch: branch.display_name(),
        detached: branch.head.is_none(),
        upstream: branch.upstream.clone().filter(|_| !branch.upstream_gone),
        default_branch,
        ahead: branch.ahead,
        behind: branch.behind,
        clean: counts.total == 0,
        staged_count: counts.staged,
        unstaged_count: counts.unstaged,
        untracked_count: counts.untracked,
        conflicted_count: counts.conflicted,
        total_changes: counts.total,
        changes,
        changes_truncated,
        local_branches,
        remote_branches,
        remotes: config::read_repository_config(&repository).remotes,
        recent_commits: match commits {
            Some(SectionValue::Commits(commits)) => commits.as_ref().clone(),
            _ => Vec::new(),
        },
        stashes: match stashes {
            Some(SectionValue::Stashes(stashes)) => stashes.as_ref().clone(),
            _ => Vec::new(),
        },
        stash_count: repository_status.stash_count,
        worktrees: match worktrees {
            Some(SectionValue::Worktrees(worktrees)) => worktrees.as_ref().clone(),
            _ => Vec::new(),
        },
        operation: current_operation(&repository),
        sections: options
            .sections
            .iter()
            .map(|section| section.as_str().to_string())
            .collect(),
        untracked_files: options.untracked.as_str().to_string(),
        last_fetched_at: last_fetched_at(&repository),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requested_sections_and_untracked_mode() {
        let request = WorkspaceGitOverviewRequest {
            workspace_root: "/workspace".to_string(),
            repository_root: "/workspace".to_string(),
            sections: Some(vec!["branches".to_string(), "worktrees".to_string()]),
            untracked_files: Some("all".to_string()),
        };
        let options = request.options().expect("the options should parse");
        assert!(options.includes(OverviewSection::Branches));
        assert!(options.includes(OverviewSection::Worktrees));
        assert!(!options.includes(OverviewSection::Numstat));
        assert_eq!(options.untracked, status::UntrackedFiles::All);
        let invalid = WorkspaceGitOverviewRequest {
            sections: Some(vec!["everything".to_string()]),
            ..request
        };
        assert!(invalid.options().is_err());
    }

    #[test]
    fn splits_numstat_paths_into_bounded_batches() {
        let long = "a".repeat(4_000);
        let batches = path_batches([long.as_str(), long.as_str(), "short"].into_iter());
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[1], vec![long.as_str(), "short"]);
    }

    #[test]
    fn submodule_pointer_changes_count_without_running_git() {
        let hash = "a".repeat(40);
        let output = [
            format!("1 .M SC.. 160000 160000 160000 {hash} {hash} modules/api"),
            format!("1 A. SC.. 000000 160000 160000 {hash} {hash} modules/new"),
            format!("1 D. SC.. 160000 000000 000000 {hash} {hash} modules/old"),
        ]
        .join("\0");
        let repository_status = status::parse_status_v2(&output);
        assert!(repository_status
            .entries
            .iter()
            .all(|entry| entry.submodule));
        let missing = std::env::temp_dir().join("machdoch-overview-no-repository");
        let counts = load_numstat(&missing, &repository_status, true);
        assert_eq!(counts.get("modules/api"), Some(&(Some(1), Some(1))));
        assert_eq!(counts.get("modules/new"), Some(&(Some(1), Some(0))));
        assert_eq!(counts.get("modules/old"), Some(&(Some(0), Some(1))));
    }
}
