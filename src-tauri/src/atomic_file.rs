use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[cfg(windows)]
use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
};

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct AtomicWriteOptions {
    #[cfg(unix)]
    unix_mode: Option<u32>,
}

impl AtomicWriteOptions {
    pub(crate) fn with_unix_mode(mode: u32) -> Self {
        #[cfg(not(unix))]
        let _ = mode;

        Self {
            #[cfg(unix)]
            unix_mode: Some(mode),
        }
    }
}

pub(crate) fn write_file_atomic(
    destination: &Path,
    contents: &[u8],
    options: AtomicWriteOptions,
) -> io::Result<()> {
    let temporary_path = create_temporary_sibling_file(destination, contents, options)?;

    match replace_file(&temporary_path, destination) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            Err(error)
        }
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fn to_wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let source = to_wide(source.as_os_str());
    let destination = to_wide(destination.as_os_str());

    // `std::fs::rename` does not replace an existing destination on Windows.
    // MoveFileEx keeps the atomic sibling-file replacement guarantee used by
    // every persisted config while also flushing the rename before returning.
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| io::Error::other(format!("failed to replace destination: {error}")))
}

fn create_temporary_sibling_file(
    destination: &Path,
    contents: &[u8],
    options: AtomicWriteOptions,
) -> io::Result<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    create_temporary_sibling_file_with_seed(destination, contents, options, timestamp)
}

fn create_temporary_sibling_file_with_seed(
    destination: &Path,
    contents: &[u8],
    options: AtomicWriteOptions,
    timestamp: u128,
) -> io::Result<PathBuf> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("atomic-write");
    let process_id = std::process::id();

    for attempt in 0..16_u8 {
        let temporary_path = parent.join(format!(
            ".{file_name}.{process_id}.{timestamp}.{attempt}.tmp"
        ));

        let mut open_options = OpenOptions::new();
        open_options.write(true).create_new(true);

        #[cfg(unix)]
        if let Some(mode) = options.unix_mode {
            open_options.mode(mode);
        }

        match open_options.open(&temporary_path) {
            Ok(mut temporary_file) => {
                if let Err(error) = write_temporary_file(&mut temporary_file, contents, options) {
                    let _ = fs::remove_file(&temporary_path);
                    return Err(error);
                }

                return Ok(temporary_path);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!(
            "unable to create a unique temporary file next to {}",
            destination.display()
        ),
    ))
}

fn write_temporary_file(
    temporary_file: &mut File,
    contents: &[u8],
    options: AtomicWriteOptions,
) -> io::Result<()> {
    #[cfg(not(unix))]
    let _ = options;

    #[cfg(unix)]
    if let Some(mode) = options.unix_mode {
        let mut permissions = temporary_file.metadata()?.permissions();
        permissions.set_mode(mode);
        temporary_file.set_permissions(permissions)?;
    }

    temporary_file.write_all(contents)?;
    temporary_file.sync_all()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn temp_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();

        std::env::temp_dir().join(format!("machdoch-atomic-file-{name}-{unique}"))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn atomic_write_creates_file_with_full_contents() {
        let directory = temp_test_directory("create");
        let destination = directory.join("config.json");
        fs::create_dir_all(&directory).expect("test directory should be created");

        write_file_atomic(
            &destination,
            b"{\n  \"ok\": true\n}\n",
            AtomicWriteOptions::default(),
        )
        .expect("atomic write should succeed");

        assert_eq!(
            fs::read_to_string(&destination).expect("destination should be readable"),
            "{\n  \"ok\": true\n}\n"
        );

        cleanup(&directory);
    }

    #[test]
    fn atomic_write_replaces_existing_file_with_full_contents() {
        let directory = temp_test_directory("replace");
        let destination = directory.join("config.json");
        fs::create_dir_all(&directory).expect("test directory should be created");
        fs::write(&destination, "{\n  \"version\": 1\n}\n")
            .expect("initial destination should be written");

        write_file_atomic(
            &destination,
            b"{\n  \"version\": 2\n}\n",
            AtomicWriteOptions::default(),
        )
        .expect("existing destination should be replaced");

        assert_eq!(
            fs::read_to_string(&destination).expect("destination should be readable"),
            "{\n  \"version\": 2\n}\n"
        );

        cleanup(&directory);
    }

    #[test]
    fn atomic_write_failed_temporary_creation_preserves_existing_file() {
        let directory = temp_test_directory("preserve");
        let destination = directory.join("config.json");
        fs::create_dir_all(&directory).expect("test directory should be created");
        fs::write(&destination, "{\n  \"valid\": true\n}\n")
            .expect("existing config should be written");

        let file_name = destination
            .file_name()
            .and_then(|value| value.to_str())
            .expect("destination file name should be valid");
        let process_id = std::process::id();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        for attempt in 0..16_u8 {
            fs::write(
                directory.join(format!(
                    ".{file_name}.{process_id}.{timestamp}.{attempt}.tmp"
                )),
                "collision",
            )
            .expect("temporary collision file should be created");
        }

        let error = create_temporary_sibling_file_with_seed(
            &destination,
            b"{\n  \"valid\": false\n}\n",
            AtomicWriteOptions::default(),
            timestamp,
        )
        .expect_err("temporary creation should fail after repeated collisions");

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(&destination).expect("existing config should remain readable"),
            "{\n  \"valid\": true\n}\n"
        );

        cleanup(&directory);
    }
}
