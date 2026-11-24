use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
    thread,
};

use ignore::{gitignore::Gitignore, WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};

const MAX_INDEXED_FILES: usize = 500_000;
const DEFAULT_RESULTS: usize = 50;
const MAX_RESULTS: usize = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFileSearchRequest {
    workspace_root: String,
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileMatch {
    path: String,
    score: i64,
    positions: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileSearchResult {
    matches: Vec<WorkspaceFileMatch>,
    indexed_files: usize,
    limit_reached: bool,
}

struct IndexedFile {
    path: String,
    lower: Vec<char>,
    name_start: usize,
}

impl IndexedFile {
    fn new(path: String) -> Self {
        let lower = path.to_lowercase().chars().collect::<Vec<_>>();
        let name_start = lower
            .iter()
            .rposition(|character| *character == '/')
            .map_or(0, |index| index + 1);
        Self {
            path,
            lower,
            name_start,
        }
    }
}

struct FileIndex {
    files: Vec<IndexedFile>,
    positions: HashMap<String, usize>,
    limit_reached: bool,
    ignores: Gitignore,
}

impl FileIndex {
    fn insert(&mut self, path: String) {
        if self.positions.contains_key(&path) || self.files.len() >= MAX_INDEXED_FILES {
            return;
        }
        self.positions.insert(path.clone(), self.files.len());
        self.files.push(IndexedFile::new(path));
    }

    fn remove_prefix(&mut self, path: &str) {
        let directory = format!("{path}/");
        let before = self.files.len();
        self.files
            .retain(|file| file.path != path && !file.path.starts_with(&directory));
        if self.files.len() != before {
            self.positions = self
                .files
                .iter()
                .enumerate()
                .map(|(index, file)| (file.path.clone(), index))
                .collect();
        }
    }
}

static INDEXES: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<FileIndex>>>>> = OnceLock::new();
static LISTENING: OnceLock<()> = OnceLock::new();

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn indexes() -> MutexGuard<'static, HashMap<PathBuf, Arc<Mutex<FileIndex>>>> {
    lock(INDEXES.get_or_init(Default::default))
}

fn relative_text(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let text = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    (!text.is_empty()).then_some(text)
}

fn walk(root: &Path) -> (Vec<String>, bool) {
    let collected = Mutex::new(Vec::<String>::new());
    let limit_reached = std::sync::atomic::AtomicBool::new(false);
    WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .filter_entry(|entry| entry.file_name() != ".git")
        .threads(thread::available_parallelism().map_or(4, |count| count.get().min(8)))
        .build_parallel()
        .run(|| {
            Box::new(|entry| {
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry
                    .file_type()
                    .is_some_and(|kind| kind.is_file() || kind.is_symlink())
                {
                    return WalkState::Continue;
                }
                let Some(path) = relative_text(root, entry.path()) else {
                    return WalkState::Continue;
                };
                let mut files = lock(&collected);
                if files.len() >= MAX_INDEXED_FILES {
                    limit_reached.store(true, std::sync::atomic::Ordering::Relaxed);
                    return WalkState::Quit;
                }
                files.push(path);
                WalkState::Continue
            })
        });
    let mut files = collected
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner);
    files.sort_unstable();
    (files, limit_reached.into_inner())
}

fn root_ignores(root: &Path) -> Gitignore {
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    builder.add(root.join(".gitignore"));
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

fn build(root: &Path) -> FileIndex {
    let (paths, limit_reached) = walk(root);
    let mut index = FileIndex {
        files: Vec::with_capacity(paths.len()),
        positions: HashMap::with_capacity(paths.len()),
        limit_reached,
        ignores: root_ignores(root),
    };
    for path in paths {
        index.insert(path);
    }
    index
}

fn apply_change(root: &Path, index: &mut FileIndex, relative: &str) {
    let absolute = root.join(relative);
    match std::fs::metadata(&absolute) {
        Ok(metadata) if metadata.is_file() => {
            if !index
                .ignores
                .matched_path_or_any_parents(Path::new(relative), false)
                .is_ignore()
            {
                index.insert(relative.to_string());
            }
        }
        Ok(metadata) if metadata.is_dir() => {
            for path in walk(&absolute).0 {
                index.insert(format!("{relative}/{path}"));
            }
        }
        Ok(_) => {}
        Err(_) => index.remove_prefix(relative),
    }
}

fn listen_for_changes() {
    LISTENING.get_or_init(|| {
        crate::workspace_watch::add_listener(|event| {
            let Ok(root) = std::fs::canonicalize(&event.workspace_root) else {
                return;
            };
            let Some(index) = indexes().get(&root).cloned() else {
                return;
            };
            if event.rescan || event.paths_truncated {
                let rebuilt = build(&root);
                *lock(&index) = rebuilt;
                return;
            }
            let mut index = lock(&index);
            if event.paths.iter().any(|path| path.ends_with(".gitignore")) {
                index.ignores = root_ignores(&root);
            }
            for path in &event.paths {
                apply_change(&root, &mut index, path);
            }
        });
    });
}

fn index_for(root: &Path) -> Arc<Mutex<FileIndex>> {
    listen_for_changes();
    if let Some(index) = indexes().get(root) {
        return Arc::clone(index);
    }
    let built = Arc::new(Mutex::new(build(root)));
    crate::workspace_watch::ensure_watching(root);
    Arc::clone(indexes().entry(root.to_path_buf()).or_insert(built))
}

fn fuzzy_score(query: &[char], candidate: &IndexedFileView<'_>) -> Option<(i64, Vec<usize>)> {
    if query.is_empty() {
        return Some((0, Vec::new()));
    }
    let text = candidate.lower;
    let mut positions = Vec::with_capacity(query.len());
    let mut start = 0;
    let name_text = &text[candidate.name_start..];
    if let Some(found) = find_subsequence(query, name_text) {
        positions.extend(found.into_iter().map(|index| index + candidate.name_start));
    } else {
        for character in query {
            let index = text[start..].iter().position(|value| value == character)? + start;
            positions.push(index);
            start = index + 1;
        }
    }
    let mut score = 0i64;
    let mut previous = None::<usize>;
    for &index in &positions {
        score += 10;
        if index >= candidate.name_start {
            score += 15;
        }
        if index == candidate.name_start {
            score += 25;
        }
        if index > 0 && matches!(text[index - 1], '/' | '-' | '_' | '.' | ' ') {
            score += 12;
        }
        if previous.is_some_and(|previous| previous + 1 == index) {
            score += 18;
        }
        previous = Some(index);
    }
    let name_length = (text.len() - candidate.name_start) as i64;
    score -= text.len() as i64 / 4 + name_length / 2;
    Some((score, positions))
}

fn find_subsequence(query: &[char], text: &[char]) -> Option<Vec<usize>> {
    let mut positions = Vec::with_capacity(query.len());
    let mut start = 0;
    for character in query {
        let index = text[start..].iter().position(|value| value == character)? + start;
        positions.push(index);
        start = index + 1;
    }
    Some(positions)
}

struct IndexedFileView<'a> {
    lower: &'a [char],
    name_start: usize,
}

type ScoredFile<'a> = (i64, &'a IndexedFile, Vec<usize>);

fn match_order(left: &ScoredFile, right: &ScoredFile) -> std::cmp::Ordering {
    right
        .0
        .cmp(&left.0)
        .then_with(|| left.1.path.cmp(&right.1.path))
}

fn best_matches<'a>(files: &'a [IndexedFile], query: &[char], limit: usize) -> Vec<ScoredFile<'a>> {
    let mut found = files
        .iter()
        .filter_map(|file| {
            let (score, positions) = fuzzy_score(
                query,
                &IndexedFileView {
                    lower: &file.lower,
                    name_start: file.name_start,
                },
            )?;
            Some((score, file, positions))
        })
        .collect::<Vec<_>>();
    if limit > 0 && limit < found.len() {
        found.select_nth_unstable_by(limit - 1, match_order);
        found.truncate(limit);
    }
    found
}

fn search(index: &FileIndex, query: &str, limit: usize) -> Vec<WorkspaceFileMatch> {
    let query = query
        .to_lowercase()
        .replace('\\', "/")
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<Vec<_>>();

    let workers = thread::available_parallelism()
        .map_or(1, usize::from)
        .min(8);
    let chunk = index.files.len().div_ceil(workers).max(4096);
    let mut matches = if index.files.len() <= chunk {
        best_matches(&index.files, &query, limit)
    } else {
        thread::scope(|scope| {
            index
                .files
                .chunks(chunk)
                .map(|files| scope.spawn(|| best_matches(files, &query, limit)))
                .collect::<Vec<_>>()
                .into_iter()
                .flat_map(|worker| worker.join().unwrap_or_default())
                .collect::<Vec<_>>()
        })
    };
    matches.sort_by(match_order);
    matches
        .into_iter()
        .take(limit)
        .map(|(score, file, positions)| WorkspaceFileMatch {
            path: file.path.clone(),
            score,
            positions,
        })
        .collect()
}

pub(crate) fn search_files(
    request: WorkspaceFileSearchRequest,
) -> Result<WorkspaceFileSearchResult, String> {
    let root = std::fs::canonicalize(request.workspace_root.trim()).map_err(|error| {
        format!(
            "Workspace {} is unavailable: {error}",
            request.workspace_root
        )
    })?;
    let index = index_for(&root);
    let index = lock(&index);
    let limit = request
        .limit
        .unwrap_or(DEFAULT_RESULTS)
        .clamp(1, MAX_RESULTS);
    Ok(WorkspaceFileSearchResult {
        matches: search(&index, &request.query, limit),
        indexed_files: index.files.len(),
        limit_reached: index.limit_reached,
    })
}

#[cfg(test)]
pub(crate) fn reset_indexes() {
    indexes().clear();
}

#[tauri::command]
pub async fn search_workspace_files(
    request: WorkspaceFileSearchRequest,
) -> Result<WorkspaceFileSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || search_files(request))
        .await
        .map_err(|error| format!("The file search stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        time::{Duration, Instant, SystemTime},
    };

    use super::*;

    fn workspace(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!("machdoch-file-index-{name}-{unique}"));
        fs::create_dir_all(root.join("src/components")).expect("folders should be created");
        fs::create_dir_all(root.join("node_modules/pkg")).expect("folders should be created");
        fs::write(root.join(".gitignore"), "node_modules/\n").expect("ignore should write");
        fs::write(root.join("src/components/button.tsx"), "").expect("file should write");
        fs::write(root.join("src/components/button-group.tsx"), "").expect("file should write");
        fs::write(root.join("src/main.ts"), "").expect("file should write");
        fs::write(root.join("node_modules/pkg/button.js"), "").expect("file should write");
        root
    }

    fn query(root: &Path, text: &str) -> Vec<String> {
        search_files(WorkspaceFileSearchRequest {
            workspace_root: root.display().to_string(),
            query: text.to_string(),
            limit: None,
        })
        .expect("search should succeed")
        .matches
        .into_iter()
        .map(|found| found.path)
        .collect()
    }

    #[test]
    fn ranks_file_name_matches_first_and_respects_gitignore() {
        let root = workspace("rank");
        let results = query(&root, "button");
        assert_eq!(results[0], "src/components/button.tsx");
        assert!(results.contains(&"src/components/button-group.tsx".to_string()));
        assert!(!results.iter().any(|path| path.starts_with("node_modules")));
        assert_eq!(query(&root, "sc/btn")[0], "src/components/button.tsx");
        assert!(query(&root, "zzz").is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn watcher_keeps_the_index_current() {
        let root = workspace("watch");
        assert!(query(&root, "added").is_empty());
        let canonical = fs::canonicalize(&root).expect("root should canonicalize");
        crate::workspace_watch::subscribe(&canonical.display().to_string()).expect("watch");
        thread::sleep(Duration::from_millis(300));
        fs::write(root.join("src/added-file.ts"), "").expect("file should write");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && query(&root, "added").is_empty() {
            thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(query(&root, "added"), vec!["src/added-file.ts".to_string()]);
        fs::remove_file(root.join("src/added-file.ts")).expect("file should delete");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !query(&root, "added").is_empty() {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(query(&root, "added").is_empty());
        crate::workspace_watch::unsubscribe(&canonical.display().to_string()).expect("unwatch");
        let _ = fs::remove_dir_all(root);
    }
}
