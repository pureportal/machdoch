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
    write_file_atomic_with_operations(
        destination,
        contents,
        options,
        &mut SystemAtomicFileOperations,
    )
}

trait AtomicFileOperations {
    fn write_all(&mut self, file: &mut File, contents: &[u8]) -> io::Result<()>;
    fn sync_all(&mut self, file: &File) -> io::Result<()>;
    fn replace(&mut self, source: &Path, destination: &Path) -> io::Result<()>;
    fn remove(&mut self, path: &Path) -> io::Result<()>;
}

struct SystemAtomicFileOperations;

impl AtomicFileOperations for SystemAtomicFileOperations {
    fn write_all(&mut self, file: &mut File, contents: &[u8]) -> io::Result<()> {
        file.write_all(contents)
    }

    fn sync_all(&mut self, file: &File) -> io::Result<()> {
        file.sync_all()
    }

    fn replace(&mut self, source: &Path, destination: &Path) -> io::Result<()> {
        replace_file(source, destination)
    }

    fn remove(&mut self, path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }
}

fn write_file_atomic_with_operations(
    destination: &Path,
    contents: &[u8],
    options: AtomicWriteOptions,
    operations: &mut impl AtomicFileOperations,
) -> io::Result<()> {
    let temporary_path =
        create_temporary_sibling_file_with_operations(destination, contents, options, operations)?;

    match operations.replace(&temporary_path, destination) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = operations.remove(&temporary_path);
            Err(error)
        }
    }
}

/// Atomically moves a file to another name in the same directory and makes
/// the namespace change durable on platforms with an explicit primitive.
pub(crate) fn rename_file_atomic(source: &Path, destination: &Path) -> io::Result<()> {
    if source.parent() != destination.parent() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic file moves must stay in one directory",
        ));
    }
    replace_file(source, destination)
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)?;
    #[cfg(unix)]
    {
        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        File::open(parent)?.sync_all()?;
    }
    Ok(())
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

fn create_temporary_sibling_file_with_operations(
    destination: &Path,
    contents: &[u8],
    options: AtomicWriteOptions,
    operations: &mut impl AtomicFileOperations,
) -> io::Result<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    create_temporary_sibling_file_with_seed_and_operations(
        destination,
        contents,
        options,
        timestamp,
        operations,
    )
}

#[cfg(test)]
fn create_temporary_sibling_file_with_seed(
    destination: &Path,
    contents: &[u8],
    options: AtomicWriteOptions,
    timestamp: u128,
) -> io::Result<PathBuf> {
    create_temporary_sibling_file_with_seed_and_operations(
        destination,
        contents,
        options,
        timestamp,
        &mut SystemAtomicFileOperations,
    )
}

fn create_temporary_sibling_file_with_seed_and_operations(
    destination: &Path,
    contents: &[u8],
    options: AtomicWriteOptions,
    timestamp: u128,
    operations: &mut impl AtomicFileOperations,
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
                if let Err(error) = write_temporary_file_with_operations(
                    &mut temporary_file,
                    contents,
                    options,
                    operations,
                ) {
                    let _ = operations.remove(&temporary_path);
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

fn write_temporary_file_with_operations(
    temporary_file: &mut File,
    contents: &[u8],
    options: AtomicWriteOptions,
    operations: &mut impl AtomicFileOperations,
) -> io::Result<()> {
    #[cfg(not(unix))]
    let _ = options;

    #[cfg(unix)]
    if let Some(mode) = options.unix_mode {
        let mut permissions = temporary_file.metadata()?.permissions();
        permissions.set_mode(mode);
        temporary_file.set_permissions(permissions)?;
    }

    operations.write_all(temporary_file, contents)?;
    operations.sync_all(temporary_file)?;

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

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FailurePoint {
        Write,
        Sync,
        Replace,
    }

    struct FaultOperations {
        failure: FailurePoint,
        fail_cleanup: bool,
        cleanup_attempts: usize,
    }

    impl FaultOperations {
        fn new(failure: FailurePoint) -> Self {
            Self {
                failure,
                fail_cleanup: false,
                cleanup_attempts: 0,
            }
        }

        fn injected_error() -> io::Error {
            io::Error::other("injected atomic-file failure")
        }
    }

    impl AtomicFileOperations for FaultOperations {
        fn write_all(&mut self, file: &mut File, contents: &[u8]) -> io::Result<()> {
            if self.failure == FailurePoint::Write {
                file.write_all(&contents[..contents.len() / 2])?;
                return Err(Self::injected_error());
            }
            file.write_all(contents)
        }

        fn sync_all(&mut self, file: &File) -> io::Result<()> {
            if self.failure == FailurePoint::Sync {
                return Err(Self::injected_error());
            }
            file.sync_all()
        }

        fn replace(&mut self, source: &Path, destination: &Path) -> io::Result<()> {
            if self.failure == FailurePoint::Replace {
                return Err(Self::injected_error());
            }
            replace_file(source, destination)
        }

        fn remove(&mut self, path: &Path) -> io::Result<()> {
            self.cleanup_attempts += 1;
            if self.fail_cleanup {
                return Err(Self::injected_error());
            }
            fs::remove_file(path)
        }
    }

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

    fn temporary_artifacts(directory: &Path) -> Vec<PathBuf> {
        fs::read_dir(directory)
            .expect("test directory should be readable")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with('.') && name.ends_with(".tmp"))
            })
            .collect()
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

    #[test]
    fn injected_write_sync_and_replace_failures_preserve_destination_and_cleanup_temporary_file() {
        for failure in [
            FailurePoint::Write,
            FailurePoint::Sync,
            FailurePoint::Replace,
        ] {
            let directory = temp_test_directory(&format!("injected-{failure:?}"));
            let destination = directory.join("config.json");
            fs::create_dir_all(&directory).expect("test directory should be created");
            let previous = b"{\n  \"version\": 1\n}\n";
            fs::write(&destination, previous).expect("initial destination should be written");
            let mut operations = FaultOperations::new(failure);

            let error = write_file_atomic_with_operations(
                &destination,
                b"{\n  \"version\": 2\n}\n",
                AtomicWriteOptions::default(),
                &mut operations,
            )
            .expect_err("the injected failure should abort the atomic write");

            assert_eq!(error.kind(), io::ErrorKind::Other);
            assert_eq!(
                fs::read(&destination).expect("destination should remain readable"),
                previous,
                "{failure:?} must preserve the previous complete destination"
            );
            assert_eq!(operations.cleanup_attempts, 1);
            assert!(
                temporary_artifacts(&directory).is_empty(),
                "{failure:?} should remove its owned temporary file"
            );
            cleanup(&directory);
        }
    }

    #[test]
    fn cleanup_failure_does_not_mask_the_atomic_operation_error_or_change_destination() {
        let directory = temp_test_directory("injected-cleanup");
        let destination = directory.join("config.json");
        fs::create_dir_all(&directory).expect("test directory should be created");
        fs::write(&destination, b"previous").expect("initial destination should be written");
        let mut operations = FaultOperations::new(FailurePoint::Replace);
        operations.fail_cleanup = true;

        let error = write_file_atomic_with_operations(
            &destination,
            b"next",
            AtomicWriteOptions::default(),
            &mut operations,
        )
        .expect_err("replacement should fail");

        assert_eq!(error.to_string(), "injected atomic-file failure");
        assert_eq!(
            fs::read(&destination).expect("destination should remain readable"),
            b"previous"
        );
        assert_eq!(operations.cleanup_attempts, 1);
        assert_eq!(
            temporary_artifacts(&directory).len(),
            1,
            "an artifact may remain only when its cleanup itself fails"
        );
        cleanup(&directory);
    }

    #[test]
    fn atomic_rename_moves_a_file_within_its_directory() {
        let directory = temp_test_directory("rename");
        let source = directory.join("active.json");
        let destination = directory.join("retired.json");
        fs::create_dir_all(&directory).expect("test directory should be created");
        fs::write(&source, "active").expect("source should be written");

        rename_file_atomic(&source, &destination).expect("rename should succeed");

        assert!(!source.exists());
        assert_eq!(
            fs::read_to_string(&destination).expect("destination should be readable"),
            "active"
        );

        cleanup(&directory);
    }

    #[test]
    fn atomic_rename_rejects_cross_directory_moves() {
        let source = Path::new("first").join("active.json");
        let destination = Path::new("second").join("retired.json");

        assert_eq!(
            rename_file_atomic(&source, &destination)
                .expect_err("cross-directory rename should be rejected")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
