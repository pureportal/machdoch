use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

const LOCK_SUFFIX: &str = ".machdoch.lock";
const OWNER_DIRECTORY_PREFIX: &str = "owner.";
const OWNER_FILE_NAME: &str = "owner.json";
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(20);
const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const LOCK_CLEANUP_RETRY_TIMEOUT: Duration = Duration::from_secs(2);
const STALE_LOCK_AGE: Duration = Duration::from_secs(120);
static TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct FileLockOwner {
    token: String,
    pid: u32,
}

#[derive(Debug)]
struct ObservedFileLockOwner {
    owner: FileLockOwner,
    path: PathBuf,
}

/// Cross-process lock shared with the Node runtime. Both implementations use
/// an atomically-created sibling directory named `<destination>.machdoch.lock`
/// containing the same owner metadata shape.
pub(crate) struct CooperativeFileLock {
    path: PathBuf,
    token: String,
}

impl Drop for CooperativeFileLock {
    fn drop(&mut self) {
        let _ = release_owned_lock(&self.path, &self.token);
    }
}

fn lock_path(destination: &Path) -> PathBuf {
    PathBuf::from(format!("{}{}", destination.to_string_lossy(), LOCK_SUFFIX))
}

fn owner_path(path: &Path) -> PathBuf {
    path.join(OWNER_FILE_NAME)
}

fn create_token() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{}-{timestamp}-{sequence}", std::process::id())
}

fn load_observed_owner(path: &Path) -> Option<ObservedFileLockOwner> {
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !file_type.is_dir() || !name.starts_with(OWNER_DIRECTORY_PREFIX) {
                continue;
            }

            let Some(token) = name.strip_prefix(OWNER_DIRECTORY_PREFIX) else {
                continue;
            };
            let owner_path = entry.path();
            let Ok(raw) = fs::read_to_string(owner_path.join(OWNER_FILE_NAME)) else {
                continue;
            };
            let Ok(owner) = serde_json::from_str::<FileLockOwner>(&raw) else {
                continue;
            };
            if owner.token == token {
                return Some(ObservedFileLockOwner {
                    owner,
                    path: owner_path,
                });
            }
        }
    }

    // Versions before the token-directory protocol wrote owner.json directly
    // inside the canonical lock directory. Keep recognizing that layout so an
    // abandoned lock from an older binary cannot block startup forever.
    let raw = fs::read_to_string(owner_path(path)).ok()?;
    let owner = serde_json::from_str::<FileLockOwner>(&raw).ok()?;
    Some(ObservedFileLockOwner {
        owner,
        path: path.to_path_buf(),
    })
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
    use windows::Win32::{
        Foundation::{CloseHandle, E_ACCESSDENIED},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => {
                let mut exit_code = 0_u32;
                let alive = GetExitCodeProcess(handle, &mut exit_code).is_ok() && exit_code == 259;
                let _ = CloseHandle(handle);
                alive
            }
            Err(error) => error.code() == E_ACCESSDENIED,
        }
    }
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    let result = unsafe { kill(pid as i32, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(3)
}

#[cfg(not(any(unix, windows)))]
fn is_process_alive(_pid: u32) -> bool {
    true
}

fn create_quarantine_path(path: &Path, token: &str) -> PathBuf {
    PathBuf::from(format!(
        "{}.quarantine.{}.{}.{}",
        path.to_string_lossy(),
        std::process::id(),
        token,
        create_token()
    ))
}

fn remove_directory_tree(path: &Path) -> io::Result<()> {
    let started = std::time::Instant::now();

    loop {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::DirectoryNotEmpty
                        | io::ErrorKind::PermissionDenied
                        | io::ErrorKind::ResourceBusy
                ) && started.elapsed() < LOCK_CLEANUP_RETRY_TIMEOUT =>
            {
                thread::sleep(LOCK_RETRY_DELAY);
            }
            Err(error) => return Err(error),
        }
    }
}

fn create_owned_directory_candidate(target: &Path, token: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(format!(
        "{}.candidate.{}.{}.{}",
        target.to_string_lossy(),
        std::process::id(),
        token,
        create_token()
    ));
    fs::create_dir(&candidate).map_err(|error| {
        format!(
            "Failed to create configuration lock candidate {}: {error}",
            candidate.display()
        )
    })?;
    let owner = FileLockOwner {
        token: token.to_string(),
        pid: std::process::id(),
    };
    let raw = serde_json::to_vec(&owner)
        .map_err(|error| format!("Failed to serialize configuration lock owner: {error}"))?;
    let owner_directory = candidate.join(format!("{OWNER_DIRECTORY_PREFIX}{token}"));
    if let Err(error) =
        fs::create_dir(&owner_directory).and_then(|()| fs::write(owner_path(&owner_directory), raw))
    {
        let _ = fs::remove_dir_all(&candidate);
        return Err(format!(
            "Failed to record configuration lock candidate {}: {error}",
            candidate.display()
        ));
    }
    Ok(candidate)
}

fn quarantine_stale_lock(path: &Path) -> Result<(), String> {
    let Some(observed) = load_observed_owner(path) else {
        if fs::metadata(path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= STALE_LOCK_AGE)
        {
            // Current owners are installed as populated directory candidates
            // in one rename. A delayed remove therefore fails against every
            // fresh populated owner.
            let _ = fs::remove_dir(path);
        }
        return Ok(());
    };
    let metadata = match fs::metadata(owner_path(&observed.path)) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect configuration lock {}: {error}",
                path.display()
            ))
        }
    };
    let modified = metadata.modified().unwrap_or(SystemTime::now());
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default();
    if age < STALE_LOCK_AGE {
        return Ok(());
    }

    if is_process_alive(observed.owner.pid) {
        return Ok(());
    }

    let quarantine_path = create_quarantine_path(path, &observed.owner.token);
    match fs::rename(&observed.path, &quarantine_path) {
        Ok(()) => {
            let _ = fs::remove_dir(path);
            remove_directory_tree(&quarantine_path).map_err(|error| {
                format!(
                    "Failed to remove stale configuration lock {}: {error}",
                    quarantine_path.display()
                )
            })?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            let still_same_owner = load_observed_owner(path).is_some_and(|current| {
                current.owner.token == observed.owner.token
                    && current.owner.pid == observed.owner.pid
            });
            if !still_same_owner {
                return Ok(());
            }
            if matches!(
                error.kind(),
                io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy
            ) {
                // Windows can report access denied while the winning rename is
                // still being finalized. Defer to the acquisition retry loop.
                return Ok(());
            }
            return Err(format!(
                "Failed to quarantine stale configuration lock {}: {error}",
                path.display()
            ));
        }
    }

    Ok(())
}

fn release_owned_lock(path: &Path, token: &str) -> Result<(), String> {
    let Some(observed) = load_observed_owner(path) else {
        return Ok(());
    };
    if observed.owner.token != token || observed.owner.pid != std::process::id() {
        return Ok(());
    }

    let quarantine_path = create_quarantine_path(path, token);
    match fs::rename(&observed.path, &quarantine_path) {
        Ok(()) => {
            let _ = fs::remove_dir(path);
            remove_directory_tree(&quarantine_path).map_err(|error| {
                format!(
                    "Failed to remove released configuration lock {}: {error}",
                    quarantine_path.display()
                )
            })
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to release configuration lock {}: {error}",
            path.display()
        )),
    }
}

pub(crate) fn acquire_cooperative_file_lock(
    destination: &Path,
) -> Result<CooperativeFileLock, String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let path = lock_path(destination);
    let token = create_token();
    let owner = FileLockOwner {
        token: token.clone(),
        pid: std::process::id(),
    };
    let candidate = create_owned_directory_candidate(&path, &owner.token)?;
    let started = std::time::Instant::now();

    let acquired = (|| -> Result<(), String> {
        loop {
            match fs::rename(&candidate, &path) {
                Ok(()) => return Ok(()),
                Err(_error) if candidate.exists() => {
                    if path.exists() {
                        quarantine_stale_lock(&path)?;
                    }

                    if started.elapsed() >= LOCK_TIMEOUT {
                        return Err(format!(
                            "Timed out waiting for configuration lock {}.",
                            path.display()
                        ));
                    }

                    thread::sleep(LOCK_RETRY_DELAY);
                }
                Err(error) => {
                    return Err(format!(
                        "Failed to acquire configuration lock {}: {error}",
                        path.display()
                    ));
                }
            }
        }
    })();

    if acquired.is_err() {
        let _ = fs::remove_dir_all(&candidate);
    }
    acquired?;

    Ok(CooperativeFileLock { path, token })
}

pub(crate) fn with_cooperative_file_lock<T>(
    destination: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _lock = acquire_cooperative_file_lock(destination)?;
    operation()
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, FileTimes, OpenOptions},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        thread,
        time::{Duration, SystemTime},
    };

    use super::*;

    fn test_destination() -> (PathBuf, PathBuf) {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("machdoch-lock-{unique}"));
        fs::create_dir_all(&directory).expect("test directory should exist");
        (directory.join("config.json"), directory)
    }

    #[test]
    fn serializes_operations_for_the_same_destination() {
        let (destination, directory) = test_destination();
        let first =
            acquire_cooperative_file_lock(&destination).expect("first lock should be acquired");
        assert!(lock_path(&destination).is_dir());
        drop(first);
        let second = acquire_cooperative_file_lock(&destination)
            .expect("released lock should be acquired again");
        drop(second);

        assert!(!lock_path(&destination).exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn release_does_not_remove_a_lock_owned_by_another_token() {
        let (destination, directory) = test_destination();
        let lock = acquire_cooperative_file_lock(&destination).expect("lock should be acquired");
        let observed = load_observed_owner(&lock.path).expect("owner should be observable");
        fs::write(
            owner_path(&observed.path),
            serde_json::to_vec(&FileLockOwner {
                token: "replacement".to_string(),
                pid: std::process::id(),
            })
            .expect("replacement owner should serialize"),
        )
        .expect("replacement owner should write");

        drop(lock);
        assert!(lock_path(&destination).exists());

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn serializes_two_contenders_recovering_the_same_stale_owner() {
        let (destination, directory) = test_destination();
        let path = lock_path(&destination);
        fs::create_dir(&path).expect("stale lock directory should be created");
        let owner_directory = path.join("owner.dead-owner");
        fs::create_dir(&owner_directory).expect("stale owner directory should be created");
        fs::write(
            owner_path(&owner_directory),
            serde_json::to_vec(&FileLockOwner {
                token: "dead-owner".to_string(),
                pid: 2_000_000_000,
            })
            .expect("stale owner should serialize"),
        )
        .expect("stale owner should write");
        let owner_file = OpenOptions::new()
            .write(true)
            .open(owner_path(&owner_directory))
            .expect("stale owner should open");
        owner_file
            .set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(180)))
            .expect("stale owner timestamp should update");
        drop(owner_file);

        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let handles = (0..2)
            .map(|_| {
                let destination = destination.clone();
                let active = Arc::clone(&active);
                let max_active = Arc::clone(&max_active);
                thread::spawn(move || {
                    with_cooperative_file_lock(&destination, || {
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        max_active.fetch_max(current, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(30));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle
                .join()
                .expect("lock contender should not panic")
                .expect("lock contender should complete");
        }

        assert_eq!(max_active.load(Ordering::SeqCst), 1);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn recovers_a_stale_owner_from_the_legacy_flat_layout() {
        let (destination, directory) = test_destination();
        let path = lock_path(&destination);
        fs::create_dir(&path).expect("legacy lock directory should be created");
        fs::write(
            owner_path(&path),
            serde_json::to_vec(&FileLockOwner {
                token: "legacy-dead-owner".to_string(),
                pid: 2_000_000_000,
            })
            .expect("legacy owner should serialize"),
        )
        .expect("legacy owner should write");
        let owner_file = OpenOptions::new()
            .write(true)
            .open(owner_path(&path))
            .expect("legacy owner should open");
        owner_file
            .set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(180)))
            .expect("legacy owner timestamp should update");
        drop(owner_file);

        with_cooperative_file_lock(&destination, || Ok(()))
            .expect("legacy stale lock should be recovered");

        assert!(!path.exists());
        let _ = fs::remove_dir_all(directory);
    }
}
