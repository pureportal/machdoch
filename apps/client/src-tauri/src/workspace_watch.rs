use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock, PoisonError},
    thread,
    time::{Duration, Instant},
};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

const DEBOUNCE: Duration = Duration::from_millis(120);
const MAX_BATCH_DELAY: Duration = Duration::from_millis(600);
const MAX_RETAINED_EVENTS: usize = 256;
const MAX_EVENT_PATHS: usize = 200;
const MAX_TRACKED_WORKTREE_PATHS: usize = 256;
const IMPLICIT_WATCH_IDLE: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryChangeKind {
    Worktree,
    Index,
    Refs,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChange {
    pub repository_root: String,
    pub kinds: Vec<RepositoryChangeKind>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeEvent {
    pub sequence: u64,
    pub workspace_root: String,
    pub repositories: Vec<RepositoryChange>,
    pub paths: Vec<String>,
    pub paths_truncated: bool,
    pub rescan: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeEvents {
    pub cursor: u64,
    pub events: Vec<WorkspaceChangeEvent>,
    pub watching: bool,
}

struct WatchedRepository {
    root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    ignores: Mutex<HashMap<PathBuf, Arc<Gitignore>>>,
}

#[derive(Default)]
struct PendingBatch {
    repositories: HashMap<PathBuf, HashSet<RepositoryChangeKind>>,
    paths: Vec<String>,
    paths_truncated: bool,
    rescan: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RepositoryGenerations {
    pub worktree: u64,
    pub index: u64,
    pub refs: u64,
}

impl RepositoryGenerations {
    fn bump(&mut self, kind: RepositoryChangeKind) {
        match kind {
            RepositoryChangeKind::Worktree => self.worktree += 1,
            RepositoryChangeKind::Index => self.index += 1,
            RepositoryChangeKind::Refs => self.refs += 1,
        }
    }
}

#[derive(Default)]
struct WorktreePathLog {
    floor: u64,
    entries: VecDeque<(u64, PathBuf)>,
}

impl WorktreePathLog {
    fn record(&mut self, generation: u64, path: PathBuf) {
        self.entries.push_back((generation, path));
        while self.entries.len() > MAX_TRACKED_WORKTREE_PATHS {
            if let Some((dropped, _)) = self.entries.pop_front() {
                self.floor = dropped;
            }
        }
    }

    fn reset(&mut self, generation: u64) {
        self.entries.clear();
        self.floor = generation;
    }

    fn since(&self, generation: u64) -> Option<Vec<PathBuf>> {
        (generation >= self.floor).then(|| {
            self.entries
                .iter()
                .filter(|(changed, _)| *changed > generation)
                .map(|(_, path)| path.clone())
                .collect()
        })
    }
}

#[derive(Default)]
struct WatchState {
    repositories: Vec<Arc<WatchedRepository>>,
    generations: HashMap<PathBuf, RepositoryGenerations>,
    worktree_paths: HashMap<PathBuf, WorktreePathLog>,
    sequence: u64,
    events: VecDeque<WorkspaceChangeEvent>,
}

struct WatchedWorkspace {
    root: PathBuf,
    state: Mutex<WatchState>,
    subscribers: Mutex<usize>,
    last_used: Mutex<Instant>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

type Listener = Arc<dyn Fn(&WorkspaceChangeEvent) + Send + Sync>;

static WORKSPACES: OnceLock<Mutex<HashMap<PathBuf, Arc<WatchedWorkspace>>>> = OnceLock::new();
static LISTENERS: OnceLock<Mutex<Vec<Listener>>> = OnceLock::new();

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn workspaces() -> MutexGuard<'static, HashMap<PathBuf, Arc<WatchedWorkspace>>> {
    lock(WORKSPACES.get_or_init(Default::default))
}

pub fn add_listener(listener: impl Fn(&WorkspaceChangeEvent) + Send + Sync + 'static) {
    lock(LISTENERS.get_or_init(Default::default)).push(Arc::new(listener));
}

fn directory_ignores(directory: &Path, git_dir: Option<&Path>) -> Gitignore {
    let mut builder = GitignoreBuilder::new(directory);
    builder.add(directory.join(".gitignore"));
    if let Some(git_dir) = git_dir {
        builder.add(git_dir.join("info").join("exclude"));
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

fn watched_repository(root: &Path) -> Option<WatchedRepository> {
    let (git_dir, common_dir) = crate::workspace_git::repository_directories(root)?;
    Some(WatchedRepository {
        root: root.to_path_buf(),
        git_dir,
        common_dir,
        ignores: Mutex::new(HashMap::new()),
    })
}

fn git_internal_kind(relative: &Path) -> Option<RepositoryChangeKind> {
    let mut components = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy());
    let first = components.next()?;
    let name = relative
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    if name.ends_with(".lock") && first != "index.lock" {
        return None;
    }
    match first.as_ref() {
        "index" | "index.lock" => Some(RepositoryChangeKind::Index),
        "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD"
        | "packed-refs" | "refs" | "rebase-merge" | "rebase-apply" | "config" | "worktrees" => {
            Some(RepositoryChangeKind::Refs)
        }
        _ => None,
    }
}

impl WatchedRepository {
    fn classify(&self, path: &Path) -> Option<RepositoryChangeKind> {
        for directory in [&self.git_dir, &self.common_dir] {
            if let Ok(relative) = path.strip_prefix(directory) {
                return git_internal_kind(relative);
            }
        }
        let relative = path.strip_prefix(&self.root).ok()?;
        if relative
            .components()
            .next()
            .is_some_and(|part| part.as_os_str() == ".git")
        {
            return None;
        }
        if relative
            .file_name()
            .is_some_and(|name| name == ".gitignore")
        {
            lock(&self.ignores).remove(path.parent().unwrap_or(&self.root));
            return Some(RepositoryChangeKind::Worktree);
        }
        (!self.ignored(relative)).then_some(RepositoryChangeKind::Worktree)
    }

    fn ignores_in(&self, directory: &Path) -> Arc<Gitignore> {
        let mut ignores = lock(&self.ignores);
        Arc::clone(ignores.entry(directory.to_path_buf()).or_insert_with(|| {
            let git_dir = (directory == self.root).then_some(self.git_dir.as_path());
            Arc::new(directory_ignores(directory, git_dir))
        }))
    }

    fn ignored(&self, relative: &Path) -> bool {
        let Some(parent) = relative
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        else {
            return false;
        };
        let mut directories = vec![self.root.clone()];
        let mut candidate = self.root.clone();
        for component in parent.components() {
            candidate.push(component);
            let ignored = directories.iter().any(|directory| {
                candidate
                    .strip_prefix(directory)
                    .is_ok_and(|local| self.ignores_in(directory).matched(local, true).is_ignore())
            });
            if ignored {
                return true;
            }
            directories.push(candidate.clone());
        }
        false
    }
}

impl WatchedWorkspace {
    fn owning_repositories(
        &self,
        path: &Path,
    ) -> Vec<(Arc<WatchedRepository>, RepositoryChangeKind)> {
        let state = lock(&self.state);
        let mut owners = state
            .repositories
            .iter()
            .filter_map(|repository| {
                let internal = path.starts_with(&repository.git_dir)
                    || path.starts_with(&repository.common_dir);
                (internal || path.starts_with(&repository.root))
                    .then(|| (Arc::clone(repository), internal))
            })
            .collect::<Vec<_>>();
        if owners.iter().any(|(_, internal)| *internal) {
            owners.retain(|(_, internal)| *internal);
        } else if let Some(deepest) = owners
            .iter()
            .map(|(repository, _)| repository.root.components().count())
            .max()
        {
            owners.retain(|(repository, _)| repository.root.components().count() == deepest);
        }
        owners
            .into_iter()
            .filter_map(|(repository, _)| {
                let kind = repository.classify(path)?;
                Some((repository, kind))
            })
            .collect()
    }

    fn record_raw(&self, paths: &[PathBuf], rescan: bool, batch: &mut PendingBatch) {
        let mut touched = Vec::new();
        for path in paths {
            for (repository, kind) in self.owning_repositories(path) {
                touched.push((repository.root.clone(), kind, path.clone()));
                batch
                    .repositories
                    .entry(repository.root.clone())
                    .or_default()
                    .insert(kind);
            }
            if path.components().any(|part| part.as_os_str() == ".git") {
                continue;
            }
            if let Ok(relative) = path.strip_prefix(&self.root) {
                if batch.paths.len() < MAX_EVENT_PATHS {
                    batch.paths.push(relative_text(relative));
                } else {
                    batch.paths_truncated = true;
                }
            }
        }
        let mut state = lock(&self.state);
        if rescan {
            batch.rescan = true;
            let roots = state
                .repositories
                .iter()
                .map(|repository| repository.root.clone())
                .collect::<Vec<_>>();
            for root in roots {
                let generations = state.generations.entry(root.clone()).or_default();
                for kind in [
                    RepositoryChangeKind::Worktree,
                    RepositoryChangeKind::Index,
                    RepositoryChangeKind::Refs,
                ] {
                    generations.bump(kind);
                }
                let worktree = generations.worktree;
                state
                    .worktree_paths
                    .entry(root.clone())
                    .or_default()
                    .reset(worktree);
                batch.repositories.entry(root).or_default().extend([
                    RepositoryChangeKind::Worktree,
                    RepositoryChangeKind::Index,
                    RepositoryChangeKind::Refs,
                ]);
            }
        }
        for (root, kind, path) in touched {
            let generations = state.generations.entry(root.clone()).or_default();
            generations.bump(kind);
            if kind == RepositoryChangeKind::Worktree {
                let worktree = generations.worktree;
                state
                    .worktree_paths
                    .entry(root)
                    .or_default()
                    .record(worktree, path);
            }
        }
    }

    fn publish(&self, batch: PendingBatch) {
        let event = {
            let mut state = lock(&self.state);
            state.sequence += 1;
            let mut repositories = batch
                .repositories
                .into_iter()
                .map(|(root, kinds)| {
                    let mut kinds = kinds.into_iter().collect::<Vec<_>>();
                    kinds.sort();
                    RepositoryChange {
                        repository_root: root.display().to_string(),
                        kinds,
                    }
                })
                .collect::<Vec<_>>();
            repositories.sort_by(|left, right| left.repository_root.cmp(&right.repository_root));
            let event = WorkspaceChangeEvent {
                sequence: state.sequence,
                workspace_root: self.root.display().to_string(),
                repositories,
                paths: batch.paths,
                paths_truncated: batch.paths_truncated,
                rescan: batch.rescan,
            };
            state.events.push_back(event.clone());
            while state.events.len() > MAX_RETAINED_EVENTS {
                state.events.pop_front();
            }
            event
        };
        let listeners = LISTENERS
            .get()
            .map(|listeners| lock(listeners).clone())
            .unwrap_or_default();
        for listener in listeners {
            listener(&event);
        }
    }
}

fn relative_text(relative: &Path) -> String {
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn run_debouncer(
    workspace: Arc<WatchedWorkspace>,
    receiver: mpsc::Receiver<notify::Result<notify::Event>>,
) {
    loop {
        let Ok(first) = receiver.recv() else {
            return;
        };
        let mut batch = PendingBatch::default();
        let started = Instant::now();
        let mut next = Some(first);
        while let Some(message) = next.take() {
            match message {
                Ok(event) => {
                    let rescan = event.need_rescan();
                    if !matches!(event.kind, EventKind::Access(_)) || rescan {
                        workspace.record_raw(&event.paths, rescan, &mut batch);
                    }
                }
                Err(_) => workspace.record_raw(&[], true, &mut batch),
            }
            let remaining = MAX_BATCH_DELAY.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            match receiver.recv_timeout(DEBOUNCE.min(remaining)) {
                Ok(message) => next = Some(message),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !batch.repositories.is_empty() || !batch.paths.is_empty() || batch.rescan {
                        workspace.publish(batch);
                    }
                    return;
                }
            }
        }
        if !batch.repositories.is_empty() || !batch.paths.is_empty() || batch.rescan {
            workspace.publish(batch);
        }
    }
}

fn load_repositories(workspace: &Path) -> Vec<Arc<WatchedRepository>> {
    crate::workspace_git::known_repository_roots(workspace)
        .into_iter()
        .filter_map(|root| watched_repository(&root).map(Arc::new))
        .collect()
}

fn start(root: &Path) -> Result<Arc<WatchedWorkspace>, String> {
    let workspace = Arc::new(WatchedWorkspace {
        root: root.to_path_buf(),
        state: Mutex::new(WatchState {
            repositories: load_repositories(root),
            ..WatchState::default()
        }),
        subscribers: Mutex::new(0),
        last_used: Mutex::new(Instant::now()),
        watcher: Mutex::new(None),
    });
    let (sender, receiver) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(sender)
        .map_err(|error| format!("Could not watch {}: {error}", root.display()))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|error| format!("Could not watch {}: {error}", root.display()))?;
    let external = lock(&workspace.state)
        .repositories
        .iter()
        .flat_map(|repository| [repository.git_dir.clone(), repository.common_dir.clone()])
        .filter(|directory| !directory.starts_with(root))
        .collect::<HashSet<_>>();
    for directory in external {
        let _ = watcher.watch(&directory, RecursiveMode::Recursive);
    }
    *lock(&workspace.watcher) = Some(watcher);
    let debounced = Arc::clone(&workspace);
    thread::Builder::new()
        .name("workspace-watch".to_string())
        .spawn(move || run_debouncer(debounced, receiver))
        .map_err(|error| format!("Could not start the workspace watcher: {error}"))?;
    Ok(workspace)
}

fn canonical(workspace_root: &str) -> Result<PathBuf, String> {
    let trimmed = workspace_root.trim();
    if trimmed.is_empty() {
        return Err("Select a workspace first.".to_string());
    }
    std::fs::canonicalize(trimmed)
        .map_err(|error| format!("Workspace {trimmed} is unavailable: {error}"))
}

fn stop_idle_implicit_watchers() {
    workspaces().retain(|_, workspace| {
        let keep = *lock(&workspace.subscribers) > 0
            || lock(&workspace.last_used).elapsed() < IMPLICIT_WATCH_IDLE;
        if !keep {
            lock(&workspace.watcher).take();
        }
        keep
    });
}

fn ensure(workspace: &Path) -> Result<Arc<WatchedWorkspace>, String> {
    stop_idle_implicit_watchers();
    if let Some(existing) = workspaces().get(workspace) {
        *lock(&existing.last_used) = Instant::now();
        return Ok(Arc::clone(existing));
    }
    let started = start(workspace)?;
    let mut registry = workspaces();
    Ok(Arc::clone(
        registry.entry(workspace.to_path_buf()).or_insert(started),
    ))
}

pub fn subscribe(workspace_root: &str) -> Result<u64, String> {
    let workspace = ensure(&canonical(workspace_root)?)?;
    *lock(&workspace.subscribers) += 1;
    let sequence = lock(&workspace.state).sequence;
    Ok(sequence)
}

pub fn unsubscribe(workspace_root: &str) -> Result<(), String> {
    let root = canonical(workspace_root)?;
    let mut registry = workspaces();
    let Some(workspace) = registry.get(&root).cloned() else {
        return Ok(());
    };
    let mut subscribers = lock(&workspace.subscribers);
    *subscribers = subscribers.saturating_sub(1);
    if *subscribers == 0 {
        registry.remove(&root);
        lock(&workspace.watcher).take();
    }
    Ok(())
}

pub fn events_after(workspace_root: &str, after: u64) -> Result<WorkspaceChangeEvents, String> {
    let root = canonical(workspace_root)?;
    let Some(workspace) = workspaces().get(&root).cloned() else {
        return Ok(WorkspaceChangeEvents {
            cursor: after,
            events: Vec::new(),
            watching: false,
        });
    };
    *lock(&workspace.last_used) = Instant::now();
    let state = lock(&workspace.state);
    let oldest = state
        .events
        .front()
        .map_or(state.sequence + 1, |event| event.sequence);
    let mut events = state
        .events
        .iter()
        .filter(|event| event.sequence > after)
        .cloned()
        .collect::<Vec<_>>();
    if after + 1 < oldest && after < state.sequence {
        events.insert(
            0,
            WorkspaceChangeEvent {
                sequence: oldest.saturating_sub(1),
                workspace_root: workspace.root.display().to_string(),
                repositories: Vec::new(),
                paths: Vec::new(),
                paths_truncated: true,
                rescan: true,
            },
        );
    }
    Ok(WorkspaceChangeEvents {
        cursor: state.sequence,
        events,
        watching: true,
    })
}

pub fn refresh_repositories(workspace: &Path) {
    let Some(watched) = workspaces().get(workspace).cloned() else {
        return;
    };
    let repositories = load_repositories(workspace);
    lock(&watched.state).repositories = repositories;
}

pub fn repository_generations(repository: &Path) -> Option<RepositoryGenerations> {
    workspaces()
        .values()
        .filter(|workspace| repository.starts_with(&workspace.root))
        .find_map(|workspace| {
            let state = lock(&workspace.state);
            state
                .repositories
                .iter()
                .any(|watched| watched.root == repository)
                .then(|| {
                    state
                        .generations
                        .get(repository)
                        .copied()
                        .unwrap_or_default()
                })
        })
}

pub fn worktree_generation(repository: &Path) -> Option<u64> {
    repository_generations(repository).map(|generations| generations.worktree)
}

pub fn worktree_paths_since(repository: &Path, generation: u64) -> Option<(u64, Vec<PathBuf>)> {
    workspaces()
        .values()
        .filter(|workspace| repository.starts_with(&workspace.root))
        .find_map(|workspace| {
            let state = lock(&workspace.state);
            if !state
                .repositories
                .iter()
                .any(|watched| watched.root == repository)
            {
                return None;
            }
            let current = state
                .generations
                .get(repository)
                .map(|generations| generations.worktree)
                .unwrap_or_default();
            let paths = match state.worktree_paths.get(repository) {
                Some(log) => log.since(generation)?,
                None if generation == current => Vec::new(),
                None => return None,
            };
            Some((current, paths))
        })
}

pub fn ensure_watching(workspace: &Path) -> bool {
    ensure(workspace).is_ok()
}

#[tauri::command]
pub async fn watch_workspace(workspace_root: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || subscribe(&workspace_root))
        .await
        .map_err(|error| format!("The workspace watcher stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn unwatch_workspace(workspace_root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || unsubscribe(&workspace_root))
        .await
        .map_err(|error| format!("The workspace watcher stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn read_workspace_changes(
    workspace_root: String,
    after: u64,
) -> Result<WorkspaceChangeEvents, String> {
    tauri::async_runtime::spawn_blocking(move || events_after(&workspace_root, after))
        .await
        .map_err(|error| format!("The workspace watcher stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::{env, fs, time::SystemTime};

    use super::*;
    use crate::workspace_git::test_repository;

    fn wait_for(condition: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn unique_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        env::temp_dir().join(format!(
            "machdoch-watch-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn classifies_git_internals_by_change_kind() {
        assert_eq!(
            git_internal_kind(Path::new("index")),
            Some(RepositoryChangeKind::Index)
        );
        assert_eq!(
            git_internal_kind(Path::new("HEAD")),
            Some(RepositoryChangeKind::Refs)
        );
        assert_eq!(
            git_internal_kind(Path::new("refs/heads/main")),
            Some(RepositoryChangeKind::Refs)
        );
        assert_eq!(git_internal_kind(Path::new("objects/ab/cdef")), None);
        assert_eq!(git_internal_kind(Path::new("refs/heads/main.lock")), None);
        assert_eq!(
            git_internal_kind(Path::new("fsmonitor--daemon/cookies/1")),
            None
        );
    }

    #[test]
    fn reports_worktree_index_and_ref_changes_and_skips_ignored_directories() {
        let root = unique_root("events");
        test_repository(&root);
        fs::write(root.join(".gitignore"), "build/\n").expect("the ignore file should write");
        fs::create_dir_all(root.join("build")).expect("the ignored folder should be created");
        let workspace_root = root.display().to_string();
        let canonical_root = fs::canonicalize(&root).expect("the root should canonicalize");
        subscribe(&workspace_root).expect("the watcher should start");
        thread::sleep(Duration::from_millis(300));
        let generation = || {
            repository_generations(&canonical_root)
                .expect("the repository is watched")
                .worktree
        };

        let before_ignored = generation();
        fs::write(root.join("build").join("output.bin"), "binary")
            .expect("ignored output should write");
        thread::sleep(Duration::from_millis(400));
        assert_eq!(
            generation(),
            before_ignored,
            "ignored directories must not invalidate Git state"
        );

        let cursor = events_after(&workspace_root, 0)
            .expect("events should load")
            .cursor;
        fs::write(root.join("tracked.txt"), "edited\n").expect("the edit should write");
        assert!(wait_for(|| generation() > before_ignored));
        assert!(wait_for(|| {
            events_after(&workspace_root, cursor)
                .expect("events should load")
                .events
                .iter()
                .any(|event| {
                    event.paths.iter().any(|path| path == "tracked.txt")
                        && event
                            .repositories
                            .iter()
                            .any(|change| change.kinds.contains(&RepositoryChangeKind::Worktree))
                })
        }));

        let cursor = events_after(&workspace_root, 0)
            .expect("events should load")
            .cursor;
        crate::workspace_git::run_required("git", &["add", "tracked.txt"], &root)
            .expect("staging should succeed");
        assert!(wait_for(|| {
            events_after(&workspace_root, cursor)
                .expect("events should load")
                .events
                .iter()
                .any(|event| {
                    event
                        .repositories
                        .iter()
                        .any(|change| change.kinds.contains(&RepositoryChangeKind::Index))
                })
        }));

        let cursor = events_after(&workspace_root, 0)
            .expect("events should load")
            .cursor;
        crate::workspace_git::run_required("git", &["switch", "--quiet", "-c", "topic"], &root)
            .expect("the switch should succeed");
        assert!(wait_for(|| {
            events_after(&workspace_root, cursor)
                .expect("events should load")
                .events
                .iter()
                .any(|event| {
                    event
                        .repositories
                        .iter()
                        .any(|change| change.kinds.contains(&RepositoryChangeKind::Refs))
                })
        }));
        unsubscribe(&workspace_root).expect("the watcher should stop");
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn worktree_path_log_answers_only_inside_its_window() {
        let mut log = WorktreePathLog::default();
        log.record(1, PathBuf::from("a"));
        log.record(2, PathBuf::from("b"));
        assert_eq!(log.since(1), Some(vec![PathBuf::from("b")]));
        assert_eq!(log.since(0).map(|paths| paths.len()), Some(2));
        for generation in 3..(3 + MAX_TRACKED_WORKTREE_PATHS as u64) {
            log.record(generation, PathBuf::from("c"));
        }
        assert_eq!(log.since(1), None);
        log.reset(500);
        assert_eq!(log.since(499), None);
        assert_eq!(log.since(500), Some(Vec::new()));
    }
}
