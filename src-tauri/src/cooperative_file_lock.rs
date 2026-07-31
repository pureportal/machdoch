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

trait LockRuntime {
    fn now(&self) -> SystemTime;
    fn is_process_alive(&self, pid: u32) -> bool;
    fn elapsed(&self, started: std::time::Instant) -> Duration;
    fn sleep(&self, duration: Duration);
}

struct SystemLockRuntime;

impl LockRuntime for SystemLockRuntime {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }

    fn is_process_alive(&self, pid: u32) -> bool {
        process_is_alive(pid)
    }

    fn elapsed(&self, started: std::time::Instant) -> Duration {
        started.elapsed()
    }

    fn sleep(&self, duration: Duration) {
        thread::sleep(duration);
    }
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

    None
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
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
fn process_is_alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    let result = unsafe { kill(pid as i32, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(3)
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive(_pid: u32) -> bool {
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

fn is_path_stale(path: &Path, runtime: &impl LockRuntime) -> bool {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| runtime.now().duration_since(modified).ok())
        .is_some_and(|age| age >= STALE_LOCK_AGE)
}

fn remove_directory_tree(path: &Path, runtime: &impl LockRuntime) -> io::Result<()> {
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
                ) && runtime.elapsed(started) < LOCK_CLEANUP_RETRY_TIMEOUT =>
            {
                runtime.sleep(LOCK_RETRY_DELAY);
            }
            Err(error) => return Err(error),
        }
    }
}

fn cleanup_quarantined_owner(
    lock_path: &Path,
    quarantine_path: &Path,
    runtime: &impl LockRuntime,
) -> io::Result<()> {
    // This is deliberately non-recursive: a successor may have installed its
    // own token directory after this owner was quarantined.
    let _ = fs::remove_dir(lock_path);
    remove_directory_tree(quarantine_path, runtime)
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

fn quarantine_stale_lock(path: &Path, runtime: &impl LockRuntime) -> Result<(), String> {
    let Some(observed) = load_observed_owner(path) else {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if !file_type.is_dir() || !name.starts_with(OWNER_DIRECTORY_PREFIX) {
                    continue;
                }

                let stale_path = entry.path();
                let owner_file = owner_path(&stale_path);
                let metadata_path = if owner_file.exists() {
                    owner_file
                } else {
                    stale_path.clone()
                };
                if !is_path_stale(&metadata_path, runtime) {
                    continue;
                }

                let token = name
                    .strip_prefix(OWNER_DIRECTORY_PREFIX)
                    .expect("token owner prefix was checked");
                let quarantine_path = create_quarantine_path(path, token);
                match fs::rename(&stale_path, &quarantine_path) {
                    Ok(()) => {
                        cleanup_quarantined_owner(path, &quarantine_path, runtime).map_err(
                            |error| {
                                format!(
                                "Failed to remove malformed stale configuration lock {}: {error}",
                                quarantine_path.display()
                            )
                            },
                        )?;
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy
                        ) => {}
                    Err(error) => {
                        return Err(format!(
                            "Failed to quarantine malformed stale configuration lock {}: {error}",
                            stale_path.display()
                        ));
                    }
                }
            }
        }

        if is_path_stale(path, runtime) {
            // Non-recursive removal reaps only a genuinely empty abandoned
            // lock and preserves any unrecognized user data.
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
    let modified = metadata.modified().unwrap_or_else(|_| runtime.now());
    let age = runtime.now().duration_since(modified).unwrap_or_default();
    if age < STALE_LOCK_AGE {
        return Ok(());
    }

    if runtime.is_process_alive(observed.owner.pid) {
        return Ok(());
    }

    let quarantine_path = create_quarantine_path(path, &observed.owner.token);
    match fs::rename(&observed.path, &quarantine_path) {
        Ok(()) => {
            cleanup_quarantined_owner(path, &quarantine_path, runtime).map_err(|error| {
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
            cleanup_quarantined_owner(path, &quarantine_path, &SystemLockRuntime).map_err(|error| {
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
    acquire_cooperative_file_lock_with_runtime(destination, &SystemLockRuntime)
}

fn acquire_cooperative_file_lock_with_runtime(
    destination: &Path,
    runtime: &impl LockRuntime,
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
                        quarantine_stale_lock(&path, runtime)?;
                    }

                    if runtime.elapsed(started) >= LOCK_TIMEOUT {
                        return Err(format!(
                            "Timed out waiting for configuration lock {}.",
                            path.display()
                        ));
                    }

                    runtime.sleep(LOCK_RETRY_DELAY);
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
            atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
            Arc,
        },
        thread,
        time::{Duration, Instant, SystemTime},
    };

    use super::*;

    struct TestLockRuntime {
        now: SystemTime,
        elapsed_millis: AtomicU64,
        processes_alive: AtomicBool,
    }

    impl TestLockRuntime {
        fn new(now: SystemTime, processes_alive: bool) -> Self {
            Self {
                now,
                elapsed_millis: AtomicU64::new(0),
                processes_alive: AtomicBool::new(processes_alive),
            }
        }
    }

    impl LockRuntime for TestLockRuntime {
        fn now(&self) -> SystemTime {
            self.now
        }

        fn is_process_alive(&self, _pid: u32) -> bool {
            self.processes_alive.load(Ordering::SeqCst)
        }

        fn elapsed(&self, _started: Instant) -> Duration {
            Duration::from_millis(self.elapsed_millis.load(Ordering::SeqCst))
        }

        fn sleep(&self, duration: Duration) {
            // Advance at least one second so production's ten-second timeout is
            // exercised in a bounded number of filesystem retries.
            let millis = duration.as_millis().max(1_000) as u64;
            self.elapsed_millis.fetch_add(millis, Ordering::SeqCst);
        }
    }

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
        remove_directory_tree(&directory, &SystemLockRuntime)
            .expect("test directory should be removable");
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

        remove_directory_tree(&directory, &SystemLockRuntime)
            .expect("test directory should be removable");
    }

    #[test]
    fn quarantined_owner_cleanup_cannot_remove_a_successor_lock() {
        let (destination, directory) = test_destination();
        let path = lock_path(&destination);
        fs::create_dir(&path).expect("lock directory should be created");
        let old_owner = path.join("owner.old");
        fs::create_dir(&old_owner).expect("old owner directory should be created");
        fs::write(
            owner_path(&old_owner),
            serde_json::to_vec(&FileLockOwner {
                token: "old".to_string(),
                pid: std::process::id(),
            })
            .expect("old owner should serialize"),
        )
        .expect("old owner should write");
        let quarantine = create_quarantine_path(&path, "old");
        fs::rename(&old_owner, &quarantine).expect("old owner should be quarantined");

        let successor = path.join("owner.successor");
        fs::create_dir(&successor).expect("successor directory should be created");
        fs::write(
            owner_path(&successor),
            serde_json::to_vec(&FileLockOwner {
                token: "successor".to_string(),
                pid: std::process::id(),
            })
            .expect("successor should serialize"),
        )
        .expect("successor should write");

        cleanup_quarantined_owner(&path, &quarantine, &SystemLockRuntime)
            .expect("quarantined owner should be cleaned");

        assert!(path.is_dir(), "canonical successor lock must remain");
        assert_eq!(
            load_observed_owner(&path)
                .expect("successor owner should remain observable")
                .owner
                .token,
            "successor"
        );
        remove_directory_tree(&directory, &SystemLockRuntime)
            .expect("test directory should be removable");
    }

    #[test]
    fn deterministic_runtime_times_out_for_a_live_stale_owner_without_wall_clock_delay() {
        let (destination, directory) = test_destination();
        let path = lock_path(&destination);
        let owner_directory = path.join("owner.live");
        fs::create_dir_all(&owner_directory).expect("live owner directory should be created");
        fs::write(
            owner_path(&owner_directory),
            serde_json::to_vec(&FileLockOwner {
                token: "live".to_string(),
                pid: 42,
            })
            .expect("live owner should serialize"),
        )
        .expect("live owner should write");
        let now = SystemTime::now();
        let owner_file = OpenOptions::new()
            .write(true)
            .open(owner_path(&owner_directory))
            .expect("live owner should open");
        owner_file
            .set_times(FileTimes::new().set_modified(now - Duration::from_secs(180)))
            .expect("live owner timestamp should update");
        drop(owner_file);
        let runtime = TestLockRuntime::new(now, true);

        let error = acquire_cooperative_file_lock_with_runtime(&destination, &runtime)
            .err()
            .expect("a live owner should cause timeout");

        assert!(error.contains("Timed out waiting for configuration lock"));
        assert!(runtime.elapsed_millis.load(Ordering::SeqCst) >= LOCK_TIMEOUT.as_millis() as u64);
        assert_eq!(
            load_observed_owner(&path)
                .expect("live owner must remain")
                .owner
                .token,
            "live"
        );
        remove_directory_tree(&directory, &SystemLockRuntime)
            .expect("test directory should be removable");
    }

    #[test]
    fn deterministic_runtime_recovers_a_dead_stale_owner() {
        let (destination, directory) = test_destination();
        let path = lock_path(&destination);
        let owner_directory = path.join("owner.dead");
        fs::create_dir_all(&owner_directory).expect("dead owner directory should be created");
        fs::write(
            owner_path(&owner_directory),
            serde_json::to_vec(&FileLockOwner {
                token: "dead".to_string(),
                pid: 42,
            })
            .expect("dead owner should serialize"),
        )
        .expect("dead owner should write");
        let now = SystemTime::now();
        let owner_file = OpenOptions::new()
            .write(true)
            .open(owner_path(&owner_directory))
            .expect("dead owner should open");
        owner_file
            .set_times(FileTimes::new().set_modified(now - Duration::from_secs(180)))
            .expect("dead owner timestamp should update");
        drop(owner_file);
        let runtime = TestLockRuntime::new(now, false);

        let acquired = acquire_cooperative_file_lock_with_runtime(&destination, &runtime)
            .expect("dead stale owner should be recovered");
        assert_ne!(
            load_observed_owner(&path)
                .expect("new owner should be observable")
                .owner
                .token,
            "dead"
        );
        drop(acquired);

        assert!(!path.exists());
        remove_directory_tree(&directory, &SystemLockRuntime)
            .expect("test directory should be removable");
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
        remove_directory_tree(&directory, &SystemLockRuntime)
            .expect("test directory should be removable");
    }

    #[test]
    fn recovers_a_stale_token_directory_with_truncated_owner_metadata() {
        let (destination, directory) = test_destination();
        let path = lock_path(&destination);
        fs::create_dir(&path).expect("stale lock directory should be created");
        let owner_directory = path.join("owner.truncated-owner");
        fs::create_dir(&owner_directory).expect("stale owner directory should be created");
        fs::write(owner_path(&owner_directory), []).expect("truncated owner should be written");
        let owner_file = OpenOptions::new()
            .write(true)
            .open(owner_path(&owner_directory))
            .expect("truncated owner should open");
        owner_file
            .set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(180)))
            .expect("stale owner timestamp should update");
        drop(owner_file);

        with_cooperative_file_lock(&destination, || Ok(()))
            .expect("truncated stale lock should be recovered");

        assert!(!path.exists());
        remove_directory_tree(&directory, &SystemLockRuntime)
            .expect("test directory should be removable");
    }
}
