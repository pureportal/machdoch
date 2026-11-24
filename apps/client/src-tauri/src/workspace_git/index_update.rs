use std::{fs, io::Read, path::Path};

use gix::{
    bstr::BStr,
    index::{
        entry::{stat, Flags, Mode, Stage, Stat},
        File,
    },
    worktree::stack::state::attributes::Source,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum IndexUpdate {
    Stage,
    Unstage,
}

struct EntryUpdate {
    position: usize,
    id: gix::ObjectId,
    mode: Mode,
    stat: Stat,
}

enum PathUpdate {
    Replace(EntryUpdate),
    Remove(usize),
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(super) fn supported_index(repository: &gix::Repository, index: &File) -> bool {
    index.link().is_none()
        && !index.is_sparse()
        && index.resolve_undo().is_none()
        && repository
            .config_snapshot()
            .string("core.sharedRepository")
            .is_none()
}

pub(super) fn plain_entry(index: &File, path: &BStr) -> Option<usize> {
    let position = index.entry_index_by_path_and_stage(path, Stage::Unconflicted)?;
    let entry = &index.entries()[position];
    let plain_mode = entry.mode == Mode::FILE || entry.mode == Mode::FILE_EXECUTABLE;
    let special = entry
        .flags
        .intersects(Flags::SKIP_WORKTREE | Flags::INTENT_TO_ADD | Flags::ASSUME_VALID);
    (plain_mode && !special).then_some(position)
}

pub(super) fn git_form(
    pipeline: &mut gix::filter::Pipeline<'_>,
    file: fs::File,
    path: &Path,
    index: &File,
) -> Result<Vec<u8>, String> {
    let mut content = Vec::new();
    match pipeline.convert_to_git(file, path, index).map_err(error)? {
        gix::filter::plumbing::pipeline::convert::ToGitOutcome::Unchanged(mut reader) => {
            reader.read_to_end(&mut content).map_err(error)?;
        }
        gix::filter::plumbing::pipeline::convert::ToGitOutcome::Process(mut reader) => {
            reader.read_to_end(&mut content).map_err(error)?;
        }
        gix::filter::plumbing::pipeline::convert::ToGitOutcome::Buffer(buffer) => {
            content.extend_from_slice(buffer);
        }
    }
    Ok(content)
}

fn staged_updates(
    repository: &gix::Repository,
    index: &File,
    paths: &[&str],
) -> Result<Option<Vec<PathUpdate>>, String> {
    let Some(workdir) = repository.workdir() else {
        return Ok(None);
    };
    let executable_bit = repository
        .config_snapshot()
        .boolean("core.filemode")
        .unwrap_or(!cfg!(windows));
    let attributes = repository
        .attributes_only(index, Source::WorktreeThenIdMapping)
        .map_err(error)?
        .detach();
    let mut pipeline = gix::filter::Pipeline::new(repository, attributes).map_err(error)?;
    let mut updates = Vec::with_capacity(paths.len());
    for path in paths {
        let Some(position) = plain_entry(index, BStr::new(path)) else {
            return Ok(None);
        };
        let worktree_path = workdir.join(path);
        let Ok(metadata) = gix::index::fs::Metadata::from_path_no_follow(&worktree_path) else {
            return Ok(None);
        };
        if !metadata.is_file() {
            return Ok(None);
        }
        let stat = Stat::from_fs(&metadata).map_err(error)?;
        let mode = if !executable_bit {
            index.entries()[position].mode
        } else if metadata.is_executable() {
            Mode::FILE_EXECUTABLE
        } else {
            Mode::FILE
        };
        let file = fs::File::open(&worktree_path).map_err(error)?;
        let content = git_form(&mut pipeline, file, Path::new(path), index)?;
        let id = repository.write_blob(&content).map_err(error)?.detach();
        updates.push(PathUpdate::Replace(EntryUpdate {
            position,
            id,
            mode,
            stat,
        }));
    }
    Ok(Some(updates))
}

fn unstaged_updates(
    repository: &gix::Repository,
    index: &File,
    paths: &[&str],
) -> Result<Option<Vec<PathUpdate>>, String> {
    let Ok(tree) = repository.head_tree() else {
        return Ok(None);
    };
    let mut updates = Vec::with_capacity(paths.len());
    for path in paths {
        let Some(position) = plain_entry(index, BStr::new(path)) else {
            return Ok(None);
        };
        match tree.lookup_entry_by_path(path).map_err(error)? {
            Some(entry) if entry.mode().is_blob() => {
                updates.push(PathUpdate::Replace(EntryUpdate {
                    position,
                    id: entry.object_id(),
                    mode: if entry.mode().is_executable() {
                        Mode::FILE_EXECUTABLE
                    } else {
                        Mode::FILE
                    },
                    stat: Stat::default(),
                }));
            }
            Some(_) => return Ok(None),
            None => updates.push(PathUpdate::Remove(position)),
        }
    }
    Ok(Some(updates))
}

fn apply(index: &mut File, updates: Vec<PathUpdate>, stat_options: stat::Options) {
    let timestamp = index.timestamp();
    let mut updated = vec![false; index.entries().len()];
    let mut removed = vec![false; index.entries().len()];
    for update in updates {
        match update {
            PathUpdate::Replace(update) => {
                let entry = &mut index.entries_mut()[update.position];
                entry.id = update.id;
                entry.mode = update.mode;
                entry.stat = update.stat;
                entry.flags.remove(Flags::FSMONITOR_VALID | Flags::UPTODATE);
                updated[update.position] = true;
            }
            PathUpdate::Remove(position) => removed[position] = true,
        }
    }
    for (position, entry) in index.entries_mut().iter_mut().enumerate() {
        entry.flags.remove(Flags::FSMONITOR_VALID);
        if !updated[position] && entry.stat.is_racy(timestamp, stat_options) {
            entry.stat.size = 0;
            entry.flags.remove(Flags::UPTODATE);
        }
    }
    if removed.contains(&true) {
        index.remove_entries(|position, _, _| removed[position]);
    }
}

pub(super) fn update_paths(
    repository: &Path,
    paths: &[&str],
    update: IndexUpdate,
) -> Result<bool, String> {
    let Ok(repository) = gix::open(repository) else {
        return Ok(false);
    };
    let Ok(mut index) = repository.open_index() else {
        return Ok(false);
    };
    if !supported_index(&repository, &index) {
        return Ok(false);
    }
    let updates = match update {
        IndexUpdate::Stage => staged_updates(&repository, &index, paths)?,
        IndexUpdate::Unstage => unstaged_updates(&repository, &index, paths)?,
    };
    let Some(updates) = updates else {
        return Ok(false);
    };
    let stat_options = repository.stat_options().map_err(error)?;
    apply(&mut index, updates, stat_options);
    if index
        .write(Default::default(), gix::fs::SharedPermissions::Umask)
        .is_err()
    {
        return Ok(false);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::{env, time::SystemTime};

    use super::*;
    use crate::workspace_git::{run_required, test_repository};

    fn repository(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-git-{name}-{}-{unique}",
            std::process::id()
        ));
        test_repository(&root);
        root
    }

    fn changed(repository: &Path, cached: bool) -> String {
        let mut arguments = vec!["diff", "--name-only"];
        if cached {
            arguments.push("--cached");
        }
        run_required("git", &arguments, repository).expect("git diff should run")
    }

    #[test]
    fn stages_and_unstages_tracked_files_like_git() {
        let repository = repository("index-update");
        fs::write(repository.join("tracked.txt"), "changed\n").expect("file should be written");
        fs::write(repository.join("other.txt"), "untracked\n").expect("file should be written");

        assert!(
            update_paths(&repository, &["tracked.txt"], IndexUpdate::Stage)
                .expect("staging should succeed")
        );
        assert_eq!(changed(&repository, true), "tracked.txt");
        assert_eq!(changed(&repository, false), "");
        let staged = run_required(
            "git",
            &["diff", "--cached", "--", "tracked.txt"],
            &repository,
        )
        .expect("the staged diff should be readable");
        assert!(staged.contains("+changed"));
        run_required("git", &["fsck", "--no-progress"], &repository)
            .expect("the repository should stay consistent");

        assert!(
            update_paths(&repository, &["tracked.txt"], IndexUpdate::Unstage)
                .expect("unstaging should succeed")
        );
        assert_eq!(changed(&repository, true), "");
        assert_eq!(changed(&repository, false), "tracked.txt");

        assert!(
            !update_paths(&repository, &["other.txt"], IndexUpdate::Stage)
                .expect("untracked files are left to git")
        );
        fs::write(repository.join(".git").join("index.lock"), "").expect("lock should be written");
        assert!(
            !update_paths(&repository, &["tracked.txt"], IndexUpdate::Stage)
                .expect("a held lock is left to git")
        );
        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn applies_line_ending_filters_when_staging() {
        let repository = repository("index-update-eol");
        fs::write(repository.join(".gitattributes"), "*.txt text eol=lf\n")
            .expect("attributes should be written");
        run_required("git", &["add", ".gitattributes"], &repository)
            .expect("attributes should stage");
        run_required("git", &["commit", "-q", "-m", "attributes"], &repository)
            .expect("attributes should commit");
        fs::write(repository.join("tracked.txt"), "one\r\ntwo\r\n")
            .expect("file should be written");

        assert!(
            update_paths(&repository, &["tracked.txt"], IndexUpdate::Stage)
                .expect("staging should succeed")
        );
        let blob = run_required("git", &["cat-file", "-p", ":tracked.txt"], &repository)
            .expect("the staged blob should be readable");
        assert_eq!(blob, "one\ntwo");
        let _ = fs::remove_dir_all(repository);
    }
}
