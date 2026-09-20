use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    hardware,
    storage::{save_config, StorageConfig},
    MediaResult,
};

const MARKER: &str = ".machdoch-storage";
const BUFFER_SIZE: usize = 4 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Migration {
    pub source: PathBuf,
    pub target: PathBuf,
    pub identity: String,
    pub source_identity: Option<String>,
    pub files: Vec<MoveFile>,
    directories: Vec<PathBuf>,
    pub cleaning: bool,
    pub error: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MoveFile {
    relative: PathBuf,
    pub bytes: u64,
    pub digest: Option<String>,
}

pub(super) fn completed_bytes(migration: &Migration) -> u64 {
    migration
        .files
        .iter()
        .enumerate()
        .map(|(index, file)| {
            if file.digest.is_some() {
                return file.bytes;
            }
            let temporary = file
                .relative
                .with_file_name(format!(".machdoch-moving-{}-{index}", migration.identity));
            fs::metadata(migration.target.join(temporary))
                .map_or(0, |metadata| metadata.len().min(file.bytes))
        })
        .sum()
}

fn io_error(error: std::io::Error) -> String {
    format!("Could not move assets: {error}")
}

fn ordinary_metadata(path: &Path) -> MediaResult<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(format!(
                "Linked folders and files cannot be moved: {}",
                path.display()
            ));
        }
    }
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err(format!(
            "Linked or special files cannot be moved: {}",
            path.display()
        ));
    }
    Ok(metadata)
}

fn scan(
    root: &Path,
    relative: &Path,
    files: &mut Vec<MoveFile>,
    directories: &mut Vec<PathBuf>,
) -> MediaResult<()> {
    for entry in fs::read_dir(root.join(relative)).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if relative.as_os_str().is_empty() && entry.file_name() == MARKER {
            continue;
        }
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".machdoch-moving-")
        {
            return Err("The asset folder contains an unfinished temporary file. Remove it before moving assets.".into());
        }
        let path = relative.join(entry.file_name());
        let metadata = ordinary_metadata(&entry.path())?;
        if metadata.is_dir() {
            directories.push(path.clone());
            scan(root, &path, files, directories)?;
        } else {
            files.push(MoveFile {
                relative: path,
                bytes: metadata.len(),
                digest: None,
            });
        }
    }
    Ok(())
}

pub(super) fn check_identity(root: &Path, identity: &str) -> MediaResult<()> {
    ordinary_metadata(root)?;
    ordinary_metadata(&root.join(MARKER))?;
    if fs::read_to_string(root.join(MARKER)).map_err(io_error)? != identity {
        return Err("The asset disk or folder has changed. Reconnect the original disk.".into());
    }
    Ok(())
}

fn claim_destination(migration: &Migration) -> MediaResult<()> {
    ordinary_metadata(&migration.target)?;
    if !migration.target.join(MARKER).exists()
        && !migration.cleaning
        && fs::read_dir(&migration.target)
            .map_err(io_error)?
            .next()
            .is_none()
    {
        crate::atomic_file::write_file_atomic(
            &migration.target.join(MARKER),
            migration.identity.as_bytes(),
            Default::default(),
        )
        .map_err(io_error)?;
    }
    check_identity(&migration.target, &migration.identity)
}

pub(super) fn prepare(
    control: &Path,
    config: &mut StorageConfig,
    target: &Path,
) -> MediaResult<()> {
    if config.migration.is_some() {
        return Err("Resume the existing asset move first.".into());
    }
    if !target.is_absolute() {
        return Err("Choose an absolute folder path.".into());
    }
    if !config.root.exists() && !control.join("media-storage.json").exists() {
        fs::create_dir_all(&config.root).map_err(io_error)?;
    }
    ordinary_metadata(&config.root)?;
    ordinary_metadata(target)?;
    let source = fs::canonicalize(&config.root).map_err(io_error)?;
    let target = fs::canonicalize(target).map_err(io_error)?;
    let control_path = fs::canonicalize(control).map_err(io_error)?;
    if source.starts_with(&target)
        || target.starts_with(&source)
        || control_path.starts_with(&target)
    {
        return Err("Choose a separate empty folder outside the current asset folder.".into());
    }
    if fs::read_dir(&target).map_err(io_error)?.next().is_some() {
        return Err("The destination is not empty. Choose an empty folder.".into());
    }
    if let Some(identity) = &config.identity {
        check_identity(&source, identity)?;
    }
    let database = source.join("media.sqlite3");
    if database.exists() {
        let connection =
            rusqlite::Connection::open(&database).map_err(|error| error.to_string())?;
        let busy: u32 = connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if busy != 0 {
            return Err("Media Studio database is busy. Retry after current work finishes.".into());
        }
    }
    let mut files = Vec::new();
    let mut directories = Vec::new();
    scan(&source, Path::new(""), &mut files, &mut directories)?;
    require_space(&target, files.iter().map(|file| file.bytes).sum())?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let identity: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    config.migration = Some(Migration {
        source,
        target,
        identity,
        source_identity: config.identity.clone(),
        files,
        directories,
        cleaning: false,
        error: None,
    });
    save_config(control, config)?;
    claim_destination(config.migration.as_ref().unwrap())
}

fn require_space(target: &Path, bytes: u64) -> MediaResult<()> {
    let free = hardware::available_storage_bytes(target)
        .ok_or("Could not check free space on the destination disk.")?;
    if free < bytes.saturating_add(16 * 1024 * 1024) {
        return Err(format!("Not enough free space: {:.2} GB available; {:.2} GB needed. Free up space on the destination disk.", free as f64 / 1073741824.0, bytes.saturating_add(16 * 1024 * 1024) as f64 / 1073741824.0));
    }
    Ok(())
}

fn checked_path(root: &Path, relative: &Path, create_parents: bool) -> MediaResult<PathBuf> {
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("The asset move contains an invalid path.".into());
    }
    ordinary_metadata(root)?;
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        if path != root.join(relative) && create_parents && !path.exists() {
            fs::create_dir(&path).map_err(io_error)?;
            sync_parent(&path)?;
        }
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                ordinary_metadata(&path)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(path)
}

fn sync_parent(path: &Path) -> MediaResult<()> {
    #[cfg(unix)]
    File::open(path.parent().ok_or("Asset path has no parent")?)
        .and_then(|file| file.sync_all())
        .map_err(io_error)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn digest_file(path: &Path, bytes: u64) -> MediaResult<String> {
    if ordinary_metadata(path)?.len() != bytes {
        return Err(format!("Asset size changed: {}", path.display()));
    }
    let mut file = File::open(path).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; BUFFER_SIZE];
    loop {
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn copy_file(migration: &Migration, index: usize) -> MediaResult<String> {
    let entry = &migration.files[index];
    let source = checked_path(&migration.source, &entry.relative, false)?;
    let destination = checked_path(&migration.target, &entry.relative, true)?;
    if destination.exists() {
        let source_digest = digest_file(&source, entry.bytes)?;
        if digest_file(&destination, entry.bytes)? == source_digest {
            return Ok(source_digest);
        }
        return Err(format!(
            "A destination file differs from the original: {}",
            destination.display()
        ));
    }
    let temporary_relative = entry
        .relative
        .with_file_name(format!(".machdoch-moving-{}-{index}", migration.identity));
    let temporary = checked_path(&migration.target, &temporary_relative, true)?;
    let mut output = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&temporary)
        .map_err(io_error)?;
    let mut input = File::open(&source).map_err(io_error)?;
    if input.metadata().map_err(io_error)?.len() != entry.bytes {
        return Err("An original asset changed during the move.".into());
    }
    let mut offset = output.metadata().map_err(io_error)?.len();
    if offset > entry.bytes {
        output.set_len(0).map_err(io_error)?;
        offset = 0;
    }
    let mut buffer = vec![0; BUFFER_SIZE];
    let mut existing = vec![0; BUFFER_SIZE];
    let mut digest = Sha256::new();
    let mut remaining = offset;
    while remaining > 0 {
        let count = remaining.min(BUFFER_SIZE as u64) as usize;
        input.read_exact(&mut buffer[..count]).map_err(io_error)?;
        output
            .read_exact(&mut existing[..count])
            .map_err(io_error)?;
        if buffer[..count] != existing[..count] {
            output.set_len(0).map_err(io_error)?;
            input.seek(SeekFrom::Start(0)).map_err(io_error)?;
            output.seek(SeekFrom::Start(0)).map_err(io_error)?;
            digest = Sha256::new();
            offset = 0;
            break;
        }
        digest.update(&buffer[..count]);
        remaining -= count as u64;
    }
    require_space(&migration.target, entry.bytes - offset)?;
    loop {
        let count = input.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count]).map_err(io_error)?;
        digest.update(&buffer[..count]);
    }
    output.sync_all().map_err(io_error)?;
    drop(output);
    let digest = format!("{:x}", digest.finalize());
    if digest_file(&temporary, entry.bytes)? != digest {
        return Err("Asset verification failed; the original is safe.".into());
    }
    crate::atomic_file::rename_file_atomic(&temporary, &destination).map_err(io_error)?;
    Ok(digest)
}

pub(super) fn execute(control: &Path, config: &mut StorageConfig) -> MediaResult<()> {
    let migration = config.migration.as_ref().ok_or("No asset move to resume")?;
    if fs::canonicalize(&migration.target).map_err(io_error)? != migration.target {
        return Err("The destination folder has changed.".into());
    }
    claim_destination(migration)?;
    if migration.source.exists() {
        if fs::canonicalize(&migration.source).map_err(io_error)? != migration.source {
            return Err("The original asset folder has changed.".into());
        }
        if let Some(identity) = &migration.source_identity {
            if !migration.cleaning || migration.source.join(MARKER).exists() {
                check_identity(&migration.source, identity)?;
            } else if fs::read_dir(&migration.source)
                .map_err(io_error)?
                .next()
                .is_some()
            {
                return Err("The original asset folder has changed.".into());
            }
        }
    } else if migration.cleaning {
        ordinary_metadata(
            migration
                .source
                .parent()
                .ok_or("The source disk is unavailable")?,
        )?;
    }
    if !migration.cleaning {
        ordinary_metadata(&migration.source)?;
        for directory in &migration.directories {
            let path = checked_path(&migration.target, directory, true)?;
            if !path.exists() {
                fs::create_dir(&path).map_err(io_error)?;
                sync_parent(&path)?;
            }
        }
        for index in 0..migration.files.len() {
            let migration = config.migration.as_ref().unwrap();
            let digest = copy_file(migration, index)?;
            config.migration.as_mut().unwrap().files[index].digest = Some(digest);
            save_config(control, config)?;
        }
        let migration = config.migration.as_mut().unwrap();
        config.root = migration.target.clone();
        config.identity = Some(migration.identity.clone());
        migration.cleaning = true;
        save_config(control, config)?;
    }
    let migration = config.migration.as_ref().unwrap();
    for entry in &migration.files {
        let destination = checked_path(&migration.target, &entry.relative, false)?;
        if Some(digest_file(&destination, entry.bytes)?) != entry.digest {
            return Err(
                "A copied asset failed verification; the remaining originals are safe.".into(),
            );
        }
    }
    if migration.source.exists() {
        for entry in &migration.files {
            let source = checked_path(&migration.source, &entry.relative, false)?;
            if !source.exists() {
                continue;
            }
            if Some(digest_file(&source, entry.bytes)?) != entry.digest {
                return Err(format!(
                    "An original asset changed; it was kept at {}",
                    source.display()
                ));
            }
            fs::remove_file(&source).map_err(io_error)?;
            sync_parent(&source)?;
        }
        let mut directories = migration.directories.clone();
        directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for relative in directories {
            let path = checked_path(&migration.source, &relative, false)?;
            if path.exists() {
                fs::remove_dir(&path).map_err(io_error)?;
                sync_parent(&path)?;
            }
        }
        if migration.source_identity.is_some() && migration.source.join(MARKER).exists() {
            fs::remove_file(migration.source.join(MARKER)).map_err(io_error)?;
        }
        fs::remove_dir(&migration.source).map_err(io_error)?;
        sync_parent(&migration.source)?;
    }
    let mut completed = config.clone();
    completed.migration = None;
    save_config(control, &completed)?;
    *config = completed;
    Ok(())
}

#[cfg(test)]
#[path = "storage_migration_tests.rs"]
mod tests;
