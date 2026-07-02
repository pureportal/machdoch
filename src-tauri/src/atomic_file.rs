use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

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

    match fs::rename(&temporary_path, destination) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            Err(error)
        }
    }
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
