use std::{
    fs,
    io::{self, Cursor, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use sha2::{Digest, Sha256};

use crate::atomic_file::{rename_file_atomic, write_file_atomic, AtomicWriteOptions};

use super::super::MediaResult;
use super::{InstallerArchive, SetupPhase, SetupStatus};

const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES: u64 = 256 * 1024 * 1024;

pub(super) fn install(
    root: &Path,
    version: &str,
    archive: &InstallerArchive,
    report: &impl Fn(SetupStatus),
) -> MediaResult<std::path::PathBuf> {
    let destination = root.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    let archive_path = root.join(&archive.archive);
    let cached = fs::File::open(&archive_path).ok().and_then(|file| {
        let mut bytes = Vec::new();
        file.take(MAX_ARCHIVE_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        valid_digest(&bytes, &archive.sha256).then_some(bytes)
    });
    let (bytes, cache_archive) = match cached {
        Some(bytes) => (bytes, false),
        None => {
            let url = format!(
                "https://github.com/astral-sh/uv/releases/download/{version}/{}",
                archive.archive
            );
            let client = reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(10 * 60))
                .build()
                .map_err(|error| error.to_string())?;
            let mut response = client
                .get(url)
                .send()
                .and_then(|response| response.error_for_status())
                .map_err(|error| format!("Could not download setup tools: {error}"))?;
            let total = response.content_length().filter(|length| *length > 0);
            if total.is_some_and(|length| length > MAX_ARCHIVE_BYTES) {
                return Err("Setup download exceeds its size limit".to_string());
            }
            let mut bytes = Vec::new();
            let mut buffer = [0; 64 * 1024];
            loop {
                let count = response
                    .read(&mut buffer)
                    .map_err(|error| format!("Setup download failed: {error}"))?;
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
                    return Err("Setup download exceeds its size limit".to_string());
                }
                let mut status = SetupStatus::running(SetupPhase::Downloading);
                status.download_percent =
                    total.map(|total| ((bytes.len() as u64 * 100 / total).min(100)) as u8);
                report(status);
            }
            if !valid_digest(&bytes, &archive.sha256) {
                return Err("Setup download checksum did not match".to_string());
            }
            (bytes, true)
        }
    };
    publish_download(
        cache_archive.then_some(archive_path.as_path()),
        &destination,
        archive,
        &bytes,
        write_file_atomic,
    )?;
    Ok(destination)
}

pub(super) fn publish_download(
    archive_path: Option<&Path>,
    destination: &Path,
    archive: &InstallerArchive,
    bytes: &[u8],
    mut write: impl FnMut(&Path, &[u8], AtomicWriteOptions) -> io::Result<()>,
) -> MediaResult<()> {
    let executable = extract_executable(bytes, archive)?;
    let archive_file = archive_path
        .map(|path| PreparedFile::new(path, bytes, AtomicWriteOptions::default(), &mut write))
        .transpose()
        .map_err(|error| format!("Could not cache setup tools: {error}"))?;
    let executable_file = PreparedFile::new(
        destination,
        &executable,
        AtomicWriteOptions::with_unix_mode(0o700),
        &mut write,
    )
    .map_err(|error| error.to_string())?;

    let mut files: Vec<PreparedFile> = archive_file.into_iter().collect();
    files.push(executable_file);
    for index in 0..files.len() {
        if let Err(error) = files[index].publish() {
            let recovery = files[..=index]
                .iter()
                .rev()
                .filter_map(|file| file.restore().err())
                .map(|error| error.to_string())
                .collect::<Vec<_>>();
            if recovery.is_empty() {
                return Err(error.to_string());
            }
            return Err(format!(
                "{error}; could not restore setup files: {}",
                recovery.join("; ")
            ));
        }
    }
    Ok(())
}

static NEXT_STAGING_FILE: AtomicU64 = AtomicU64::new(0);

struct StagingFile(PathBuf);

impl StagingFile {
    fn new(destination: &Path) -> io::Result<Self> {
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        let name = destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        for _ in 0..16 {
            let sequence = NEXT_STAGING_FILE.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(
                ".{name}.{}.{}.staging",
                std::process::id(),
                sequence
            ));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Self(path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Could not create setup staging file",
        ))
    }
}

impl Drop for StagingFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct PreparedFile {
    destination: PathBuf,
    staged: StagingFile,
    previous: Option<StagingFile>,
}

impl PreparedFile {
    fn new(
        destination: &Path,
        bytes: &[u8],
        options: AtomicWriteOptions,
        write: &mut impl FnMut(&Path, &[u8], AtomicWriteOptions) -> io::Result<()>,
    ) -> io::Result<Self> {
        let staged = StagingFile::new(destination)?;
        write(&staged.0, bytes, options)
            .map_err(|error| io::Error::new(error.kind(), format!("staging write: {error}")))?;
        let previous = match fs::metadata(destination) {
            Ok(_) => {
                let previous = StagingFile::new(destination)?;
                fs::copy(destination, &previous.0).map_err(|error| {
                    io::Error::new(error.kind(), format!("backup copy: {error}"))
                })?;
                fs::OpenOptions::new()
                    .write(true)
                    .open(&previous.0)?
                    .sync_all()?;
                Some(previous)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        Ok(Self {
            destination: destination.to_path_buf(),
            staged,
            previous,
        })
    }

    fn publish(&self) -> io::Result<()> {
        rename_file_atomic(&self.staged.0, &self.destination)
    }

    fn restore(&self) -> io::Result<()> {
        match &self.previous {
            Some(previous) => rename_file_atomic(&previous.0, &self.destination),
            None => match fs::remove_file(&self.destination) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            },
        }
    }
}

fn valid_digest(bytes: &[u8], expected: &str) -> bool {
    bytes.len() as u64 <= MAX_ARCHIVE_BYTES && format!("{:x}", Sha256::digest(bytes)) == expected
}

fn extract_executable(bytes: &[u8], archive: &InstallerArchive) -> MediaResult<Vec<u8>> {
    let mut output = Vec::new();
    if archive.archive.ends_with(".zip") {
        let mut zip =
            zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
        let file = zip
            .by_name(&archive.executable)
            .map_err(|error| error.to_string())?;
        file.take(MAX_EXECUTABLE_BYTES + 1)
            .read_to_end(&mut output)
            .map_err(|error| error.to_string())?;
    } else {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        for entry in tar.entries().map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.path().map_err(|error| error.to_string())?.as_ref()
                == Path::new(&archive.executable)
                && entry.header().entry_type().is_file()
            {
                entry
                    .take(MAX_EXECUTABLE_BYTES + 1)
                    .read_to_end(&mut output)
                    .map_err(|error| error.to_string())?;
                break;
            }
        }
    }
    if output.is_empty() || output.len() as u64 > MAX_EXECUTABLE_BYTES {
        return Err("Setup archive contains no valid executable".to_string());
    }
    Ok(output)
}
