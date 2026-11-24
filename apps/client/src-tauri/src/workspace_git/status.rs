use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock, PoisonError,
    },
};

use super::{
    command_output, fsmonitor, git_directories, operation_in, output_error, worktree_status,
    WorkspaceGitChange,
};

const MAX_PATHSPEC_REFRESH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum UntrackedFiles {
    Normal,
    All,
}

impl UntrackedFiles {
    pub(super) fn parse(value: Option<&str>) -> Result<Self, String> {
        match value {
            None | Some("normal") => Ok(Self::Normal),
            Some("all") => Ok(Self::All),
            Some(_) => Err("Choose normal or all untracked files.".to_string()),
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::All => "all",
        }
    }

    fn argument(self) -> &'static str {
        match self {
            Self::Normal => "--untracked-files=normal",
            Self::All => "--untracked-files=all",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct BranchState {
    pub(super) head: Option<String>,
    pub(super) oid: Option<String>,
    pub(super) upstream: Option<String>,
    pub(super) ahead: u64,
    pub(super) behind: u64,
    pub(super) upstream_gone: bool,
}

impl BranchState {
    pub(super) fn display_name(&self) -> String {
        self.head
            .clone()
            .unwrap_or_else(|| "Detached HEAD".to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StatusEntry {
    pub(super) code: [u8; 2],
    pub(super) path: String,
    pub(super) original_path: Option<String>,
    pub(super) conflicted: bool,
    pub(super) untracked: bool,
    pub(super) submodule: bool,
}

impl StatusEntry {
    pub(super) fn staged(&self) -> bool {
        !self.untracked && self.code[0] != b' '
    }

    pub(super) fn unstaged(&self) -> bool {
        !self.untracked && self.code[1] != b' '
    }

    fn to_change(&self) -> WorkspaceGitChange {
        WorkspaceGitChange {
            status: String::from_utf8_lossy(&self.code).into_owned(),
            path: self.path.clone(),
            original_path: self.original_path.clone(),
            staged: self.staged(),
            unstaged: self.unstaged(),
            untracked: self.untracked,
            conflicted: self.conflicted,
            additions: None,
            deletions: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct StatusCounts {
    pub(super) staged: usize,
    pub(super) unstaged: usize,
    pub(super) untracked: usize,
    pub(super) conflicted: usize,
    pub(super) total: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RepositoryStatus {
    pub(super) revision: u64,
    pub(super) branch: BranchState,
    pub(super) stash_count: usize,
    pub(super) entries: Vec<StatusEntry>,
}

impl RepositoryStatus {
    pub(super) fn counts(&self) -> StatusCounts {
        let mut counts = StatusCounts {
            total: self.entries.len(),
            ..StatusCounts::default()
        };
        for entry in &self.entries {
            if entry.untracked {
                counts.untracked += 1;
                continue;
            }
            counts.conflicted += usize::from(entry.conflicted);
            counts.staged += usize::from(entry.staged());
            counts.unstaged += usize::from(entry.unstaged());
        }
        counts
    }

    pub(super) fn changes(&self, limit: usize) -> (Vec<WorkspaceGitChange>, bool) {
        let mut ordered = self.entries.iter().collect::<Vec<_>>();
        ordered.sort_by_key(|entry| !entry.conflicted);
        (
            ordered
                .into_iter()
                .take(limit)
                .map(StatusEntry::to_change)
                .collect(),
            self.entries.len() > limit,
        )
    }
}

fn unchanged_as_space(code: u8) -> u8 {
    if code == b'.' {
        b' '
    } else {
        code
    }
}

fn split_fields(record: &str, count: usize) -> Option<(Vec<&str>, &str)> {
    let mut fields = Vec::with_capacity(count);
    let mut rest = record;
    for _ in 0..count {
        let (field, remaining) = rest.split_once(' ')?;
        fields.push(field);
        rest = remaining;
    }
    Some((fields, rest))
}

fn conflict_code(code: &str) -> bool {
    matches!(code, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU")
}

pub(super) fn parse_status_v2(output: &str) -> RepositoryStatus {
    let mut branch = BranchState::default();
    let mut has_ahead_behind = false;
    let mut stash_count = 0;
    let mut entries = Vec::new();
    let mut records = output.split_terminator('\0');
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => branch.oid = (value != "(initial)").then(|| value.to_string()),
                "branch.head" => branch.head = (value != "(detached)").then(|| value.to_string()),
                "branch.upstream" => branch.upstream = Some(value.to_string()),
                "branch.ab" => {
                    has_ahead_behind = true;
                    for part in value.split_whitespace() {
                        if let Some(count) = part.strip_prefix('+') {
                            branch.ahead = count.parse().unwrap_or_default();
                        } else if let Some(count) = part.strip_prefix('-') {
                            branch.behind = count.parse().unwrap_or_default();
                        }
                    }
                }
                "stash" => stash_count = value.parse().unwrap_or_default(),
                _ => {}
            }
            continue;
        }
        let entry = match record.as_bytes().first() {
            Some(b'1') => {
                split_fields(record, 8).map(|(fields, path)| (fields[1], fields[2], path, None))
            }
            Some(b'2') => split_fields(record, 9).map(|(fields, path)| {
                (
                    fields[1],
                    fields[2],
                    path,
                    records.next().map(str::to_string),
                )
            }),
            Some(b'u') => {
                split_fields(record, 10).map(|(fields, path)| (fields[1], fields[2], path, None))
            }
            Some(b'?') => {
                if let Some(path) = record.get(2..) {
                    entries.push(StatusEntry {
                        code: *b"??",
                        path: path.to_string(),
                        original_path: None,
                        conflicted: false,
                        untracked: true,
                        submodule: false,
                    });
                }
                continue;
            }
            _ => None,
        };
        let Some((code, submodule_state, path, original_path)) = entry else {
            continue;
        };
        let bytes = code.as_bytes();
        if bytes.len() != 2 {
            continue;
        }
        entries.push(StatusEntry {
            code: [unchanged_as_space(bytes[0]), unchanged_as_space(bytes[1])],
            path: path.to_string(),
            original_path,
            conflicted: record.starts_with('u') || conflict_code(code),
            untracked: false,
            submodule: submodule_state.starts_with('S'),
        });
    }
    branch.upstream_gone = branch.upstream.is_some() && !has_ahead_behind;
    RepositoryStatus {
        revision: 0,
        branch,
        stash_count,
        entries,
    }
}

pub(super) fn status_arguments(
    untracked: UntrackedFiles,
    fsmonitor: bool,
    paths: &[&str],
) -> Vec<String> {
    let mut arguments = Vec::new();
    if fsmonitor {
        arguments.extend(
            fsmonitor::configuration_arguments()
                .iter()
                .map(|value| value.to_string()),
        );
    }
    arguments.extend(
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "--show-stash",
            "-z",
            "--ignore-submodules=dirty",
            untracked.argument(),
        ]
        .map(str::to_string),
    );
    if !paths.is_empty() {
        arguments.push("--".to_string());
        arguments.extend(paths.iter().map(|path| path.to_string()));
    }
    arguments
}

pub(super) fn read_status_v2(
    repository: &Path,
    untracked: UntrackedFiles,
    fsmonitor: bool,
    paths: &[&str],
) -> Result<RepositoryStatus, String> {
    if fsmonitor {
        fsmonitor::ensure_daemon(repository);
    }
    let arguments = status_arguments(untracked, fsmonitor, paths);
    let arguments = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    let output = command_output("git", &arguments, repository)?;
    if !output.status.success() {
        return Err(output_error("git", &arguments, &output));
    }
    Ok(parse_status_v2(&String::from_utf8_lossy(&output.stdout)))
}

fn hash_file(path: &Path, hasher: &mut DefaultHasher) {
    fs::read(path).unwrap_or_default().hash(hasher);
}

fn hash_metadata(path: &Path, hasher: &mut DefaultHasher) {
    match fs::metadata(path) {
        Ok(metadata) => {
            metadata.len().hash(hasher);
            metadata.modified().ok().hash(hasher);
        }
        Err(_) => 0u8.hash(hasher),
    }
}

pub(super) fn repository_signature(repository: &Path, upstream: Option<&str>) -> Option<u64> {
    let directories = git_directories(repository)?;
    let mut hasher = DefaultHasher::new();
    let head = fs::read(directories.git_dir.join("HEAD")).unwrap_or_default();
    head.hash(&mut hasher);
    if let Some(reference) = head
        .strip_prefix(b"ref:")
        .and_then(|reference| std::str::from_utf8(reference).ok())
    {
        hash_file(&directories.common_dir.join(reference.trim()), &mut hasher);
    }
    if let Some(upstream) = upstream {
        hash_file(
            &directories
                .common_dir
                .join("refs")
                .join("remotes")
                .join(upstream),
            &mut hasher,
        );
    }
    for path in [
        directories.git_dir.join("index"),
        directories.git_dir.join("FETCH_HEAD"),
        directories.common_dir.join("packed-refs"),
        directories.common_dir.join("config"),
        directories.common_dir.join("refs").join("stash"),
        directories
            .common_dir
            .join("logs")
            .join("refs")
            .join("stash"),
        directories.common_dir.join("info").join("exclude"),
    ] {
        hash_metadata(&path, &mut hasher);
    }
    operation_in(&directories.git_dir).hash(&mut hasher);
    Some(hasher.finish())
}

struct CachedStatus {
    worktree_generation: u64,
    signature: u64,
    status: Arc<RepositoryStatus>,
}

type StatusCache = HashMap<(PathBuf, UntrackedFiles), CachedStatus>;

static STATUS_CACHE: OnceLock<Mutex<StatusCache>> = OnceLock::new();
static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);

fn status_cache() -> std::sync::MutexGuard<'static, StatusCache> {
    STATUS_CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn cached(repository: &Path, untracked: UntrackedFiles) -> Option<Arc<RepositoryStatus>> {
    let generation = crate::workspace_watch::worktree_generation(repository)?;
    let cache = status_cache();
    let entry = cache.get(&(repository.to_path_buf(), untracked))?;
    let signature = repository_signature(repository, entry.status.branch.upstream.as_deref())?;
    (entry.worktree_generation == generation && entry.signature == signature)
        .then(|| Arc::clone(&entry.status))
}

fn store(
    repository: &Path,
    untracked: UntrackedFiles,
    generation: Option<u64>,
    mut status: RepositoryStatus,
) -> Arc<RepositoryStatus> {
    status.revision = NEXT_REVISION.fetch_add(1, Ordering::Relaxed);
    let status = Arc::new(status);
    let signature = repository_signature(repository, status.branch.upstream.as_deref());
    match (generation, signature) {
        (Some(worktree_generation), Some(signature)) => {
            status_cache().insert(
                (repository.to_path_buf(), untracked),
                CachedStatus {
                    worktree_generation,
                    signature,
                    status: Arc::clone(&status),
                },
            );
        }
        _ => {
            status_cache().remove(&(repository.to_path_buf(), untracked));
        }
    }
    status
}

fn relative_paths(repository: &Path, paths: Vec<PathBuf>) -> Option<Vec<String>> {
    let mut relative = paths
        .iter()
        .map(|path| {
            let inside = path.strip_prefix(repository).ok()?;
            let text = inside
                .components()
                .map(|part| part.as_os_str().to_str())
                .collect::<Option<Vec<_>>>()?
                .join("/");
            (!text.is_empty()).then_some(text)
        })
        .collect::<Option<Vec<_>>>()?;
    relative.sort();
    relative.dedup();
    Some(relative)
}

fn refreshed(
    repository: &Path,
    untracked: UntrackedFiles,
    fsmonitor: bool,
) -> Option<Arc<RepositoryStatus>> {
    let (generation, signature, previous) = {
        let cache = status_cache();
        let entry = cache.get(&(repository.to_path_buf(), untracked))?;
        (
            entry.worktree_generation,
            entry.signature,
            Arc::clone(&entry.status),
        )
    };
    if repository_signature(repository, previous.branch.upstream.as_deref())? != signature {
        return None;
    }
    let (current, changed) = crate::workspace_watch::worktree_paths_since(repository, generation)?;
    let changed = relative_paths(repository, changed)?;
    let entries = match worktree_status::refresh_entries(repository, &previous, &changed) {
        Some(entries) => entries,
        None if changed.len() <= MAX_PATHSPEC_REFRESH => {
            let paths = changed.iter().map(String::as_str).collect::<Vec<_>>();
            let partial = read_status_v2(repository, untracked, fsmonitor, &paths).ok()?;
            let selected = paths.iter().copied().collect::<HashSet<_>>();
            patch_entries(&previous, &partial, untracked, &selected)?
        }
        None => return None,
    };
    Some(store(
        repository,
        untracked,
        Some(current),
        RepositoryStatus {
            revision: 0,
            branch: previous.branch.clone(),
            stash_count: previous.stash_count,
            entries,
        },
    ))
}

pub(super) fn known_status(
    repository: &Path,
    untracked: UntrackedFiles,
    fsmonitor: bool,
) -> Option<Arc<RepositoryStatus>> {
    cached(repository, untracked).or_else(|| refreshed(repository, untracked, fsmonitor))
}

pub(super) fn repository_status(
    repository: &Path,
    untracked: UntrackedFiles,
    fsmonitor: bool,
) -> Result<Arc<RepositoryStatus>, String> {
    if let Some(status) = known_status(repository, untracked, fsmonitor) {
        return Ok(status);
    }
    let generation = crate::workspace_watch::worktree_generation(repository);
    let status = read_status_v2(repository, untracked, fsmonitor, &[])?;
    Ok(store(repository, untracked, generation, status))
}

fn renames_possible(entries: &[StatusEntry]) -> bool {
    entries
        .iter()
        .any(|entry| !entry.untracked && matches!(entry.code[0], b'A' | b'D' | b'R' | b'C'))
}

pub(super) struct PathRefresh {
    generation: u64,
    previous: Vec<(UntrackedFiles, Arc<RepositoryStatus>)>,
}

pub(super) fn prepare_path_refresh(repository: &Path) -> Option<PathRefresh> {
    let generation = crate::workspace_watch::worktree_generation(repository)?;
    let previous = [UntrackedFiles::All, UntrackedFiles::Normal]
        .into_iter()
        .filter_map(|mode| cached(repository, mode).map(|status| (mode, status)))
        .collect::<Vec<_>>();
    (!previous.is_empty()).then_some(PathRefresh {
        generation,
        previous,
    })
}

fn patch_entries(
    previous: &RepositoryStatus,
    partial: &RepositoryStatus,
    mode: UntrackedFiles,
    selected: &HashSet<&str>,
) -> Option<Vec<StatusEntry>> {
    let touches_selection = |entry: &StatusEntry| {
        let below_selected = selected.iter().any(|path| {
            entry
                .path
                .strip_prefix(path)
                .is_some_and(|rest| rest.starts_with('/'))
        });
        below_selected
            || selected.contains(entry.path.as_str())
            || entry
                .original_path
                .as_deref()
                .is_some_and(|original| selected.contains(original))
    };
    let inside_untracked_directory = mode == UntrackedFiles::Normal
        && previous.entries.iter().any(|entry| {
            entry.untracked
                && entry.path.ends_with('/')
                && selected
                    .iter()
                    .any(|path| path.starts_with(entry.path.as_str()))
        });
    if inside_untracked_directory {
        return None;
    }
    let retained = previous
        .entries
        .iter()
        .filter(|entry| !touches_selection(entry))
        .cloned()
        .collect::<Vec<_>>();
    let patched = partial
        .entries
        .iter()
        .chain(
            previous
                .entries
                .iter()
                .filter(|entry| touches_selection(entry)),
        )
        .cloned()
        .collect::<Vec<_>>();
    if renames_possible(&patched) && renames_possible(&retained) {
        return None;
    }
    let mut entries = retained;
    entries.extend(partial.entries.iter().cloned());
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Some(entries)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum IndexChange {
    Staged,
    Unstaged,
}

fn entry_with(entry: &StatusEntry, code: [u8; 2]) -> StatusEntry {
    StatusEntry {
        code,
        untracked: &code == b"??",
        conflicted: false,
        ..entry.clone()
    }
}

fn predicted_entry(
    entry: &StatusEntry,
    change: IndexChange,
    mode: UntrackedFiles,
) -> Option<Option<StatusEntry>> {
    if entry.conflicted || entry.original_path.is_some() || entry.path.ends_with('/') {
        return None;
    }
    let becomes_untracked = |entry: &StatusEntry| {
        (mode == UntrackedFiles::All || !entry.path.contains('/'))
            .then(|| Some(entry_with(entry, *b"??")))
    };
    match (change, entry.code) {
        (IndexChange::Staged, [b'?', b'?']) => Some(Some(entry_with(entry, *b"A "))),
        (IndexChange::Staged, [b' ', worktree @ (b'M' | b'D' | b'T')]) => {
            Some(Some(entry_with(entry, [worktree, b' '])))
        }
        (IndexChange::Staged, [b'A', b'M']) => Some(Some(entry_with(entry, *b"A "))),
        (IndexChange::Staged, [b'A', b'D']) => Some(None),
        (IndexChange::Staged, [b'M', b'D']) => Some(Some(entry_with(entry, *b"D "))),
        (IndexChange::Staged, [b'M' | b'A' | b'D' | b'T', b' ']) => Some(Some(entry.clone())),
        (IndexChange::Unstaged, [index @ (b'M' | b'D' | b'T'), b' ']) => {
            Some(Some(entry_with(entry, [b' ', index])))
        }
        (IndexChange::Unstaged, [b'A', b' ' | b'M']) => becomes_untracked(entry),
        (IndexChange::Unstaged, [b'A', b'D']) => Some(None),
        (IndexChange::Unstaged, [b'M', worktree @ (b'M' | b'D')]) => {
            Some(Some(entry_with(entry, [b' ', worktree])))
        }
        (IndexChange::Unstaged, [b' ' | b'?', _]) => Some(Some(entry.clone())),
        _ => None,
    }
}

fn staged_kind(entries: &[StatusEntry], kind: u8) -> bool {
    entries
        .iter()
        .any(|entry| !entry.untracked && entry.code[0] == kind)
}

fn predict_entries(
    previous: &RepositoryStatus,
    paths: &[&str],
    change: IndexChange,
    mode: UntrackedFiles,
) -> Option<Vec<StatusEntry>> {
    if change == IndexChange::Unstaged && previous.branch.oid.is_none() {
        return None;
    }
    let selected = paths.iter().copied().collect::<HashSet<_>>();
    if selected.len() != paths.len() {
        return None;
    }
    let mut matched = 0;
    let mut touched = Vec::new();
    let mut entries = Vec::with_capacity(previous.entries.len());
    for entry in &previous.entries {
        if !selected.contains(entry.path.as_str()) {
            entries.push(entry.clone());
            continue;
        }
        matched += 1;
        if let Some(predicted) = predicted_entry(entry, change, mode)? {
            touched.push(predicted.clone());
            entries.push(predicted);
        }
    }
    let rename_candidate = staged_kind(&touched, b'A') || staged_kind(&touched, b'D');
    if matched != selected.len()
        || (rename_candidate && staged_kind(&entries, b'A') && staged_kind(&entries, b'D'))
    {
        return None;
    }
    Some(entries)
}

pub(super) fn refresh_paths(
    repository: &Path,
    prepared: PathRefresh,
    paths: &[&str],
    change: Option<IndexChange>,
    fsmonitor: bool,
) -> Result<(), String> {
    if crate::workspace_watch::worktree_generation(repository) != Some(prepared.generation) {
        forget(repository);
        return Ok(());
    }
    let selected = paths.iter().copied().collect::<HashSet<_>>();
    for (mode, previous) in prepared.previous {
        let predicted = change.and_then(|change| predict_entries(&previous, paths, change, mode));
        let (branch, stash_count, entries) = match predicted {
            Some(entries) => (previous.branch.clone(), previous.stash_count, Some(entries)),
            None => {
                let partial = read_status_v2(repository, mode, fsmonitor, paths)?;
                let entries = patch_entries(&previous, &partial, mode, &selected);
                (partial.branch, partial.stash_count, entries)
            }
        };
        match entries {
            Some(entries) => {
                store(
                    repository,
                    mode,
                    Some(prepared.generation),
                    RepositoryStatus {
                        revision: 0,
                        branch,
                        stash_count,
                        entries,
                    },
                );
            }
            None => {
                status_cache().remove(&(repository.to_path_buf(), mode));
            }
        }
    }
    Ok(())
}

pub(super) fn forget(repository: &Path) {
    status_cache().retain(|(cached, _), _| cached != repository);
}

#[cfg(test)]
pub(super) fn clear() {
    status_cache().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_stash_and_every_entry_kind() {
        let status = parse_status_v2(
            "# branch.oid abc\0# branch.head feature/x\0# branch.upstream origin/feature/x\0# branch.ab +2 -3\0# stash 4\01 .M N... 100644 100644 100644 a b src/a b.ts\02 R. N... 100644 100644 100644 a b R100 new.ts\0old.ts\0u UU N... 100644 100644 100644 100644 a b c conflict.ts\0? notes.md\01 D. N... 100644 000000 000000 a 0 gone.ts\0",
        );
        assert_eq!(status.branch.head.as_deref(), Some("feature/x"));
        assert_eq!(status.branch.upstream.as_deref(), Some("origin/feature/x"));
        assert_eq!((status.branch.ahead, status.branch.behind), (2, 3));
        assert!(!status.branch.upstream_gone);
        assert_eq!(status.stash_count, 4);
        assert_eq!(
            status
                .entries
                .iter()
                .map(|entry| (
                    String::from_utf8_lossy(&entry.code).into_owned(),
                    entry.path.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                (" M".to_string(), "src/a b.ts"),
                ("R ".to_string(), "new.ts"),
                ("UU".to_string(), "conflict.ts"),
                ("??".to_string(), "notes.md"),
                ("D ".to_string(), "gone.ts"),
            ]
        );
        assert_eq!(status.entries[1].original_path.as_deref(), Some("old.ts"));
        assert_eq!(
            status.counts(),
            StatusCounts {
                staged: 3,
                unstaged: 2,
                untracked: 1,
                conflicted: 1,
                total: 5,
            }
        );
        let (changes, truncated) = status.changes(2);
        assert_eq!(changes[0].path, "conflict.ts");
        assert!(truncated);
    }

    #[test]
    fn patches_only_the_selected_paths_into_a_cached_status() {
        let previous = parse_status_v2(
            "# branch.oid abc\0# branch.head main\01 .M N... 100644 100644 100644 a b a.ts\01 .M N... 100644 100644 100644 a b b.ts\0? new.ts\0",
        );
        let partial = parse_status_v2(
            "# branch.oid abc\0# branch.head main\01 M. N... 100644 100644 100644 a b a.ts\0",
        );
        let selected = HashSet::from(["a.ts"]);
        let entries = patch_entries(&previous, &partial, UntrackedFiles::All, &selected)
            .expect("the entries should patch");
        assert_eq!(
            entries
                .iter()
                .map(|entry| (
                    String::from_utf8_lossy(&entry.code).into_owned(),
                    entry.path.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("M ".to_string(), "a.ts"),
                (" M".to_string(), "b.ts"),
                ("??".to_string(), "new.ts"),
            ]
        );
        let staged_new = parse_status_v2(
            "# branch.oid abc\0# branch.head main\01 A. N... 000000 100644 100644 0 b new.ts\0",
        );
        let deleted = parse_status_v2(
            "# branch.oid abc\0# branch.head main\01 D. N... 100644 000000 000000 a 0 b.ts\0",
        );
        let with_deletion = patch_entries(
            &previous,
            &deleted,
            UntrackedFiles::All,
            &HashSet::from(["b.ts"]),
        )
        .expect("the entries should patch");
        assert!(patch_entries(
            &RepositoryStatus {
                entries: with_deletion,
                ..previous.clone()
            },
            &staged_new,
            UntrackedFiles::All,
            &HashSet::from(["new.ts"]),
        )
        .is_none());
    }

    fn codes(entries: &[StatusEntry]) -> Vec<(String, &str)> {
        entries
            .iter()
            .map(|entry| {
                (
                    String::from_utf8_lossy(&entry.code).into_owned(),
                    entry.path.as_str(),
                )
            })
            .collect()
    }

    #[test]
    fn predicts_staging_and_unstaging_without_rereading_status() {
        let previous = parse_status_v2(
            "# branch.oid abc\0# branch.head main\01 .M N... 100644 100644 100644 a b a.ts\01 M. N... 100644 100644 100644 a b b.ts\01 AD N... 000000 100644 000000 0 b gone.ts\0? new.ts\0? nested/new.ts\0",
        );
        let staged = predict_entries(
            &previous,
            &["a.ts", "new.ts", "gone.ts"],
            IndexChange::Staged,
            UntrackedFiles::All,
        )
        .expect("staging should be predictable");
        assert_eq!(
            codes(&staged),
            vec![
                ("M ".to_string(), "a.ts"),
                ("M ".to_string(), "b.ts"),
                ("A ".to_string(), "new.ts"),
                ("??".to_string(), "nested/new.ts"),
            ]
        );
        let unstaged = predict_entries(
            &previous,
            &["b.ts"],
            IndexChange::Unstaged,
            UntrackedFiles::All,
        )
        .expect("unstaging should be predictable");
        assert_eq!(codes(&unstaged)[1], (" M".to_string(), "b.ts"));

        let added = RepositoryStatus {
            entries: staged,
            ..previous.clone()
        };
        let nested = parse_status_v2(
            "# branch.oid abc\0# branch.head main\01 A. N... 000000 100644 100644 0 b nested/new.ts\0",
        );
        assert!(predict_entries(
            &nested,
            &["nested/new.ts"],
            IndexChange::Unstaged,
            UntrackedFiles::Normal
        )
        .is_none());
        assert!(predict_entries(
            &added,
            &["unknown.ts"],
            IndexChange::Staged,
            UntrackedFiles::All
        )
        .is_none());
        let deleted = parse_status_v2(
            "# branch.oid abc\0# branch.head main\01 .D N... 100644 100644 000000 a a old.ts\0? renamed.ts\0",
        );
        assert!(predict_entries(
            &deleted,
            &["old.ts", "renamed.ts"],
            IndexChange::Staged,
            UntrackedFiles::All
        )
        .is_none());
        let conflicted = parse_status_v2(
            "# branch.oid abc\0# branch.head main\0u UU N... 100644 100644 100644 100644 a b c conflict.ts\0",
        );
        assert!(predict_entries(
            &conflicted,
            &["conflict.ts"],
            IndexChange::Staged,
            UntrackedFiles::All
        )
        .is_none());
    }

    #[test]
    fn reports_gone_upstreams_and_detached_heads() {
        let gone = parse_status_v2(
            "# branch.oid abc\0# branch.head topic\0# branch.upstream origin/topic\0",
        );
        assert!(gone.branch.upstream_gone);
        let detached = parse_status_v2("# branch.oid abc\0# branch.head (detached)\0");
        assert_eq!(detached.branch.head, None);
        assert_eq!(detached.branch.display_name(), "Detached HEAD");
        let unborn = parse_status_v2("# branch.oid (initial)\0# branch.head main\0");
        assert_eq!(unborn.branch.oid, None);
    }
}
