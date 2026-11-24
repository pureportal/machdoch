use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock, PoisonError},
    time::SystemTime,
};

use gix::{
    bstr::BStr,
    diff::blob::{
        unified_diff::{ConsumeBinaryHunk, ContextSize},
        Algorithm, Diff, InternedInput, UnifiedDiff,
    },
    index::entry::Mode,
    worktree::stack::state::attributes::Source,
};

use super::{
    index_update,
    status::{RepositoryStatus, StatusEntry},
    MAX_GIT_DIFF_BYTES,
};

const MAX_REFRESHED_PATHS: usize = 64;
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
const BINARY_PROBE_BYTES: usize = 8000;
const MAX_CACHED_NUMSTATS: usize = 4096;

pub(super) type LineCounts = (Option<u64>, Option<u64>);

struct CachedRepository {
    config: Option<(u64, Option<SystemTime>)>,
    repository: gix::ThreadSafeRepository,
}

type NumstatKey = (gix::ObjectId, Option<(u64, Option<SystemTime>)>);

static REPOSITORIES: OnceLock<Mutex<HashMap<PathBuf, CachedRepository>>> = OnceLock::new();
static NUMSTATS: OnceLock<Mutex<HashMap<(PathBuf, String), (NumstatKey, LineCounts)>>> =
    OnceLock::new();

fn lock<T>(mutex: &'static OnceLock<Mutex<T>>) -> MutexGuard<'static, T>
where
    T: Default,
{
    mutex
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn file_stamp(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    let metadata = fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()))
}

pub(super) fn open(repository: &Path) -> Option<gix::Repository> {
    let mut cache = lock(&REPOSITORIES);
    if let Some(cached) = cache.get(repository) {
        let local = cached.repository.to_thread_local();
        if file_stamp(&local.common_dir().join("config")) == cached.config {
            return Some(local);
        }
    }
    let opened = gix::ThreadSafeRepository::open(repository).ok()?;
    let local = opened.to_thread_local();
    cache.insert(
        repository.to_path_buf(),
        CachedRepository {
            config: file_stamp(&local.common_dir().join("config")),
            repository: opened,
        },
    );
    Some(local)
}

pub(super) enum WorktreeFile {
    Missing,
    File { content: Vec<u8>, executable: bool },
}

enum IndexLookup {
    Plain { id: gix::ObjectId, mode: Mode },
    Absent,
    Unsupported,
}

pub(super) struct Worktree<'repo> {
    repository: &'repo gix::Repository,
    index: gix::worktree::Index,
    pipeline: gix::filter::Pipeline<'repo>,
    executable_bit: bool,
}

impl<'repo> Worktree<'repo> {
    pub(super) fn new(repository: &'repo gix::Repository) -> Option<Self> {
        let index = repository.index().ok()?;
        if !index_update::supported_index(repository, &index) {
            return None;
        }
        let attributes = repository
            .attributes_only(&index, Source::WorktreeThenIdMapping)
            .ok()?
            .detach();
        let pipeline = gix::filter::Pipeline::new(repository, attributes).ok()?;
        let executable_bit = repository
            .config_snapshot()
            .boolean("core.filemode")
            .unwrap_or(!cfg!(windows));
        Some(Self {
            repository,
            index,
            pipeline,
            executable_bit,
        })
    }

    pub(super) fn read(&mut self, path: &str) -> Option<WorktreeFile> {
        let full = self.repository.workdir()?.join(path);
        let metadata = match gix::index::fs::Metadata::from_path_no_follow(&full) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Some(WorktreeFile::Missing)
            }
            Err(_) => return None,
        };
        if !metadata.is_file() || metadata.len() > MAX_TEXT_BYTES {
            return None;
        }
        let file = fs::File::open(&full).ok()?;
        let content =
            index_update::git_form(&mut self.pipeline, file, Path::new(path), &self.index).ok()?;
        Some(WorktreeFile::File {
            content,
            executable: metadata.is_executable(),
        })
    }

    fn lookup(&self, path: &str) -> IndexLookup {
        let requested = BStr::new(path);
        if let Some(position) = index_update::plain_entry(&self.index, requested) {
            let entry = &self.index.entries()[position];
            return IndexLookup::Plain {
                id: entry.id,
                mode: entry.mode,
            };
        }
        let directory = format!("{path}/");
        let tracked_below = self
            .index
            .prefixed_entries_range(BStr::new(&directory))
            .is_some_and(|range| !range.is_empty());
        if tracked_below || self.index.entry_by_path(requested).is_some() {
            IndexLookup::Unsupported
        } else {
            IndexLookup::Absent
        }
    }

    pub(super) fn index_blob(&self, path: &str) -> Option<(gix::ObjectId, Vec<u8>)> {
        let IndexLookup::Plain { id, .. } = self.lookup(path) else {
            return None;
        };
        Some((id, self.repository.find_blob(id).ok()?.data.clone()))
    }

    fn worktree_code(&mut self, id: gix::ObjectId, mode: Mode, path: &str) -> Option<u8> {
        match self.read(path)? {
            WorktreeFile::Missing => Some(b'D'),
            WorktreeFile::File {
                content,
                executable,
            } => {
                let mode_changed =
                    self.executable_bit && (mode == Mode::FILE_EXECUTABLE) != executable;
                let blob = self.repository.find_blob(id).ok()?;
                Some(if mode_changed || blob.data != content {
                    b'M'
                } else {
                    b' '
                })
            }
        }
    }
}

fn touches_changed_path(entry: &StatusEntry, changed: &HashSet<&str>) -> bool {
    let untracked_directory = entry.untracked
        && entry.path.ends_with('/')
        && changed
            .iter()
            .any(|path| path.starts_with(entry.path.as_str()));
    let renamed_from = entry
        .original_path
        .as_deref()
        .is_some_and(|original| changed.contains(original));
    untracked_directory
        || renamed_from
        || (entry.conflicted && changed.contains(entry.path.as_str()))
}

pub(super) fn refresh_entries(
    repository: &Path,
    previous: &RepositoryStatus,
    changed: &[String],
) -> Option<Vec<StatusEntry>> {
    if changed.len() > MAX_REFRESHED_PATHS {
        return None;
    }
    let selected = changed.iter().map(String::as_str).collect::<HashSet<_>>();
    if previous
        .entries
        .iter()
        .any(|entry| touches_changed_path(entry, &selected))
    {
        return None;
    }
    let opened = open(repository)?;
    let mut worktree = Worktree::new(&opened)?;
    let mut entries = previous
        .entries
        .iter()
        .filter(|entry| !selected.contains(entry.path.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for path in selected {
        let prior = previous.entries.iter().find(|entry| entry.path == path);
        match worktree.lookup(path) {
            IndexLookup::Unsupported => return None,
            IndexLookup::Absent => match (prior, worktree.read(path)?) {
                (None, WorktreeFile::Missing) => {}
                (Some(prior), WorktreeFile::Missing) if prior.untracked => {}
                (Some(prior), WorktreeFile::File { .. }) if prior.untracked => {
                    entries.push(prior.clone());
                }
                _ => return None,
            },
            IndexLookup::Plain { id, mode } => {
                if prior.is_some_and(|prior| prior.untracked) {
                    return None;
                }
                let staged = prior.map_or(b' ', |prior| prior.code[0]);
                let unstaged = worktree.worktree_code(id, mode, path)?;
                if staged != b' ' || unstaged != b' ' {
                    entries.push(StatusEntry {
                        code: [staged, unstaged],
                        path: path.to_string(),
                        original_path: prior.and_then(|prior| prior.original_path.clone()),
                        conflicted: false,
                        untracked: false,
                        submodule: false,
                    });
                }
            }
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Some(entries)
}

fn binary(content: &[u8]) -> bool {
    content[..content.len().min(BINARY_PROBE_BYTES)].contains(&0)
}

fn line_counts(before: &[u8], after: &[u8]) -> LineCounts {
    if binary(before) || binary(after) {
        return (None, None);
    }
    let input = InternedInput::new(before, after);
    let diff = Diff::compute(Algorithm::Myers, &input);
    (
        Some(u64::from(diff.count_additions())),
        Some(u64::from(diff.count_removals())),
    )
}

fn head_blob(
    repository: &gix::Repository,
    tree: &gix::Tree<'_>,
    path: &str,
) -> Option<Option<Vec<u8>>> {
    match tree.lookup_entry_by_path(path).ok()? {
        Some(entry) if entry.mode().is_blob() => Some(Some(
            repository.find_blob(entry.object_id()).ok()?.data.clone(),
        )),
        Some(_) => None,
        None => Some(None),
    }
}

fn remember_numstat(key: (PathBuf, String), stamp: NumstatKey, counts: LineCounts) {
    let mut cache = lock(&NUMSTATS);
    if cache.len() >= MAX_CACHED_NUMSTATS {
        cache.clear();
    }
    cache.insert(key, (stamp, counts));
}

pub(super) fn head_numstat(repository: &Path, paths: &[&str]) -> HashMap<String, LineCounts> {
    let mut counts = HashMap::new();
    let Some(opened) = open(repository) else {
        return counts;
    };
    let (Ok(head), Ok(tree)) = (opened.head_id(), opened.head_tree()) else {
        return counts;
    };
    let head = head.detach();
    let Some(workdir) = opened.workdir().map(Path::to_path_buf) else {
        return counts;
    };
    let Some(mut worktree) = Worktree::new(&opened) else {
        return counts;
    };
    for path in paths {
        let key = (repository.to_path_buf(), path.to_string());
        let stamp = (head, file_stamp(&workdir.join(path)));
        if let Some((cached_stamp, cached)) = lock(&NUMSTATS).get(&key) {
            if *cached_stamp == stamp {
                counts.insert(path.to_string(), *cached);
                continue;
            }
        }
        let Some(before) = head_blob(&opened, &tree, path) else {
            continue;
        };
        let after = match worktree.read(path) {
            Some(WorktreeFile::Missing) => None,
            Some(WorktreeFile::File { content, .. }) => Some(content),
            None => continue,
        };
        let computed = line_counts(
            before.as_deref().unwrap_or_default(),
            after.as_deref().unwrap_or_default(),
        );
        remember_numstat(key, stamp, computed);
        counts.insert(path.to_string(), computed);
    }
    counts
}

fn plain_path(path: &str) -> bool {
    path.chars()
        .all(|character| character.is_ascii_graphic() || character == ' ')
        && !path.contains(['"', '\\'])
}

pub(super) fn unified_patch(path: &str, before: &[u8], after: &[u8]) -> Option<String> {
    let complete = |content: &[u8]| !content.is_empty() && content.ends_with(b"\n");
    if !plain_path(path) || !complete(before) || !complete(after) || binary(before) || binary(after)
    {
        return None;
    }
    let input = InternedInput::new(before, after);
    let mut diff = Diff::compute(Algorithm::Myers, &input);
    diff.postprocess_lines(&input);
    if diff.count_additions() == 0 && diff.count_removals() == 0 {
        return Some(String::new());
    }
    let hunks = UnifiedDiff::new(
        &diff,
        &input,
        ConsumeBinaryHunk::new(String::new(), "\n"),
        ContextSize::symmetrical(3),
    )
    .consume()
    .ok()?;
    let patch = format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n{hunks}");
    let patch = patch.trim_end_matches('\n').to_string();
    (patch.len() <= MAX_GIT_DIFF_BYTES).then_some(patch)
}

pub(super) struct FileVersions {
    pub(super) head: Option<Vec<u8>>,
    pub(super) index: Vec<u8>,
    pub(super) worktree: Option<Vec<u8>>,
}

pub(super) fn file_versions(
    repository: &Path,
    path: &str,
    with_head: bool,
) -> Option<FileVersions> {
    let opened = open(repository)?;
    let mut worktree = Worktree::new(&opened)?;
    let (_, index) = worktree.index_blob(path)?;
    let head = if with_head {
        let tree = opened.head_tree().ok()?;
        head_blob(&opened, &tree, path)?
    } else {
        None
    };
    let worktree = match worktree.read(path)? {
        WorktreeFile::Missing => None,
        WorktreeFile::File { content, .. } => Some(content),
    };
    Some(FileVersions {
        head,
        index,
        worktree,
    })
}

#[cfg(test)]
mod tests {
    use std::{env, time::UNIX_EPOCH};

    use super::*;
    use crate::workspace_git::{run_required, status};

    fn repository(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-worktree-status-{name}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("the directory should be created");
        for arguments in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Test"],
            vec!["config", "core.autocrlf", "false"],
        ] {
            run_required("git", &arguments, &root).expect("git setup should succeed");
        }
        fs::write(root.join("a.txt"), "one\ntwo\nthree\n").expect("the file should write");
        fs::write(root.join("b.txt"), "b\n").expect("the file should write");
        run_required("git", &["add", "."], &root).expect("git add should succeed");
        run_required("git", &["commit", "-m", "initial"], &root)
            .expect("git commit should succeed");
        root
    }

    fn git_status(root: &Path) -> Vec<StatusEntry> {
        status::read_status_v2(root, status::UntrackedFiles::Normal, false, &[])
            .expect("git status should run")
            .entries
    }

    #[test]
    fn refreshes_edited_and_deleted_files_like_git_status() {
        let root = repository("refresh");
        let previous = status::read_status_v2(&root, status::UntrackedFiles::Normal, false, &[])
            .expect("git status should run");
        fs::write(root.join("a.txt"), "one\nchanged\nthree\n").expect("the file should write");
        fs::remove_file(root.join("b.txt")).expect("the file should be removed");
        let refreshed = refresh_entries(
            &root,
            &previous,
            &["a.txt".to_string(), "b.txt".to_string()],
        )
        .expect("the refresh should run in process");
        assert_eq!(refreshed, git_status(&root));

        let edited = RepositoryStatus {
            entries: refreshed,
            ..previous.clone()
        };
        fs::write(root.join("a.txt"), "one\ntwo\nthree\n").expect("the file should write");
        let restored = refresh_entries(&root, &edited, &["a.txt".to_string()])
            .expect("the refresh should run in process");
        assert_eq!(restored, git_status(&root));

        fs::write(root.join("new.txt"), "new\n").expect("the file should write");
        assert_eq!(
            refresh_entries(&root, &edited, &["new.txt".to_string()]),
            None
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn counts_lines_and_renders_patches_that_git_can_apply() {
        let root = repository("patch");
        fs::write(root.join("a.txt"), "one\nTWO\nthree\nfour\n").expect("the file should write");
        let counts = head_numstat(&root, &["a.txt", "b.txt"]);
        assert_eq!(counts.get("a.txt"), Some(&(Some(2), Some(1))));
        assert_eq!(counts.get("b.txt"), Some(&(Some(0), Some(0))));

        let versions = file_versions(&root, "a.txt", true).expect("the versions should load");
        let patch = unified_patch(
            "a.txt",
            &versions.index,
            versions.worktree.as_deref().expect("the file exists"),
        )
        .expect("the patch should render");
        assert!(patch
            .starts_with("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@"));
        fs::write(root.join("change.patch"), format!("{patch}\n")).expect("the patch should write");
        run_required("git", &["apply", "--cached", "change.patch"], &root)
            .expect("git should accept the patch");
        let staged = run_required("git", &["diff", "--cached", "--numstat"], &root)
            .expect("git diff should run");
        assert!(staged.starts_with("2\t1\ta.txt"));
        assert_eq!(
            unified_patch("a.txt", b"same\n", b"same\n"),
            Some(String::new())
        );
        assert_eq!(unified_patch("a.txt", b"no newline", b"x\n"), None);
        let _ = fs::remove_dir_all(root);
    }
}
