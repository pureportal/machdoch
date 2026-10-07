use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use super::{manifest::RecoveryManifest, RECOVERY_FILE_ENV, RECOVERY_SESSION_ENV};
use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    child_process::configure_child_process_group,
};

pub(crate) const WATCHER_ARGUMENT: &str = "--ralph-host-watcher";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WatcherReady {
    session_id: String,
    pid: u32,
    birth_time: u64,
}

pub(super) enum WatcherProcess {
    Child(Child),
    Parent(ParentProcess),
}

impl WatcherProcess {
    pub fn is_alive(&mut self) -> Result<bool, String> {
        match self {
            Self::Child(child) => child
                .try_wait()
                .map(|status| {
                    if let Some(status) = status {
                        eprintln!("Ralph host watcher {} exited with {status}.", child.id());
                    }
                    status.is_none()
                })
                .map_err(|error| format!("Failed to monitor the Ralph host watcher: {error}")),
            Self::Parent(parent) => {
                let alive = parent.is_alive()?;
                if !alive {
                    eprintln!(
                        "Ralph parent watcher exited with code {:?}.",
                        parent.wait_for_exit()?
                    );
                }
                Ok(alive)
            }
        }
    }
}

pub(super) fn launch(path: &Path, session_id: &str) -> Result<WatcherProcess, String> {
    let pid = std::process::id();
    let birth_time = ParentProcess::birth_time(pid)?;
    let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    command.args([
        WATCHER_ARGUMENT,
        &path.to_string_lossy(),
        &pid.to_string(),
        &birth_time.to_string(),
        session_id,
    ]);
    configure_child_process_group(&mut command);
    let log = open_log(path)?;
    command
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|error| error.to_string())?)
        .stderr(log);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start the Ralph host watcher: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(ready) = read_ready(path) {
            #[cfg(windows)]
            let identity_matches = ParentProcess::open(ready.pid, ready.birth_time)
                .and_then(|process| process.ensure_alive())
                .is_ok();
            #[cfg(unix)]
            let identity_matches = child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none();
            if ready.session_id == session_id && ready.pid == child.id() && identity_matches {
                return Ok(WatcherProcess::Child(child));
            }
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!(
                "The Ralph host watcher exited before becoming ready: {status}"
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "The Ralph host watcher did not become ready within 10 seconds.".to_string(),
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub(super) fn bind(path: &Path, session_id: &str) -> Result<WatcherProcess, String> {
    let ready = read_ready(path)?;
    if ready.session_id != session_id {
        return Err("The Ralph host watcher belongs to another recovery session.".to_string());
    }
    let process = ParentProcess::open(ready.pid, ready.birth_time)?;
    process.ensure_alive()?;
    Ok(WatcherProcess::Parent(process))
}

pub(crate) fn run() -> Result<(), String> {
    let arguments: Vec<_> = std::env::args().skip(2).collect();
    if arguments.len() != 4 {
        return Err("Invalid Ralph host watcher arguments.".to_string());
    }
    let path = Path::new(&arguments[0]);
    let pid = arguments[1]
        .parse()
        .map_err(|_| "Invalid Ralph host process identifier.".to_string())?;
    let birth_time = arguments[2]
        .parse()
        .map_err(|_| "Invalid Ralph host process birth time.".to_string())?;
    let session_id = &arguments[3];
    let parent = ParentProcess::open(pid, birth_time)?;
    parent.ensure_alive()?;
    let manifest = RecoveryManifest::read(path)?;
    if manifest.session_id != *session_id {
        return Err("The Ralph host recovery session does not match its watcher.".to_string());
    }
    let ready = WatcherReady {
        session_id: session_id.clone(),
        pid: std::process::id(),
        birth_time: ParentProcess::birth_time(std::process::id())?,
    };
    write_file_atomic(
        &path.with_extension("ready.json"),
        &serde_json::to_vec(&ready).map_err(|error| error.to_string())?,
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| format!("Failed to acknowledge Ralph host watcher startup: {error}"))?;
    let exit_code = parent.wait_for_exit()?;
    eprintln!("Ralph desktop host {pid} exited with code {exit_code:?}.");
    if exit_code == Some(0) {
        return Ok(());
    }
    loop {
        let mut manifest = RecoveryManifest::read(path)?;
        if manifest.session_id != *session_id {
            return Err(
                "The Ralph host recovery session changed while watching the desktop.".to_string(),
            );
        }
        if !manifest.record_host_failure() {
            return Ok(());
        }
        manifest.persist(path)?;
        thread::sleep(Duration::from_secs(1));
        let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
        command
            .arg("--ui")
            .env(RECOVERY_FILE_ENV, path)
            .env(RECOVERY_SESSION_ENV, session_id);
        configure_child_process_group(&mut command);
        let log = open_log(path)?;
        command
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|error| error.to_string())?)
            .stderr(log);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to restart the Ralph desktop host: {error}"))?;
        eprintln!(
            "Restarted Ralph desktop host {} for recovery session {session_id}.",
            child.id()
        );
        let status = child.wait().map_err(|error| {
            format!("Failed to monitor the restarted Ralph desktop host: {error}")
        })?;
        eprintln!("Ralph desktop host {} exited with {status}.", child.id());
        if status.success() {
            return Ok(());
        }
    }
}

fn read_ready(path: &Path) -> Result<WatcherReady, String> {
    let bytes = fs::read(path.with_extension("ready.json")).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn open_log(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path.with_extension("log"))
        .map_err(|error| format!("Failed to open the Ralph host watcher log: {error}"))
}

#[cfg(windows)]
pub(super) struct ParentProcess(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl ParentProcess {
    fn birth_time(pid: u32) -> Result<u64, String> {
        Self::open_unchecked(pid)?.creation_time()
    }

    fn open_unchecked(pid: u32) -> Result<Self, String> {
        use std::os::windows::io::FromRawHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };
        unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                pid,
            )
        }
        .map(|handle| Self(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle.0) }))
        .map_err(|error| format!("Failed to bind the Ralph recovery process handle: {error}"))
    }

    fn creation_time(&self) -> Result<u64, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::FILETIME, System::Threading::GetProcessTimes};
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe {
            GetProcessTimes(
                windows::Win32::Foundation::HANDLE(self.0.as_raw_handle()),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        }
        .map_err(|error| {
            format!("Failed to verify the Ralph recovery process birth time: {error}")
        })?;
        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }

    fn open(pid: u32, birth_time: u64) -> Result<Self, String> {
        let process = Self::open_unchecked(pid)?;
        if process.creation_time()? != birth_time {
            return Err("The Ralph recovery process identifier was reused.".to_string());
        }
        Ok(process)
    }

    fn ensure_alive(&self) -> Result<(), String> {
        if !self.is_alive()? {
            return Err("The Ralph recovery process has already exited.".to_string());
        }
        Ok(())
    }

    fn is_alive(&self) -> Result<bool, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::WaitForSingleObject,
        };
        match unsafe { WaitForSingleObject(HANDLE(self.0.as_raw_handle()), 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            _ => Err(format!(
                "Failed to inspect the Ralph watcher process: {}",
                windows::core::Error::from_win32()
            )),
        }
    }

    fn wait_for_exit(&self) -> Result<Option<u32>, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{GetExitCodeProcess, WaitForSingleObject},
        };
        loop {
            let handle = HANDLE(self.0.as_raw_handle());
            match unsafe { WaitForSingleObject(handle, 250) } {
                WAIT_TIMEOUT => {}
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    unsafe { GetExitCodeProcess(handle, &mut code) }
                        .map_err(|error| error.to_string())?;
                    return Ok(Some(code));
                }
                _ => {
                    return Err(format!(
                        "Failed to wait for the Ralph desktop host: {}",
                        windows::core::Error::from_win32()
                    ))
                }
            }
        }
    }
}

#[cfg(unix)]
pub(super) struct ParentProcess(u32);

#[cfg(unix)]
impl ParentProcess {
    fn birth_time(_: u32) -> Result<u64, String> {
        Ok(0)
    }

    fn open(pid: u32, _: u64) -> Result<Self, String> {
        if unsafe { libc::getppid() } as u32 != pid {
            return Err(
                "The Ralph recovery watcher is not the desktop's parent process.".to_string(),
            );
        }
        Ok(Self(pid))
    }

    fn ensure_alive(&self) -> Result<(), String> {
        if !self.is_alive()? {
            return Err("The Ralph recovery parent process has exited.".to_string());
        }
        Ok(())
    }

    fn is_alive(&self) -> Result<bool, String> {
        Ok(unsafe { libc::getppid() } as u32 == self.0)
    }

    fn wait_for_exit(&self) -> Result<Option<u32>, String> {
        while unsafe { libc::getppid() } as u32 == self.0 {
            thread::sleep(Duration::from_millis(250));
        }
        Ok(None)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn watcher_binds_a_live_handle_and_rejects_reused_identity() {
        let pid = std::process::id();
        let birth_time = ParentProcess::birth_time(pid).unwrap();
        ParentProcess::open(pid, birth_time)
            .unwrap()
            .ensure_alive()
            .unwrap();
        assert!(ParentProcess::open(pid, birth_time + 1).is_err());
        assert!(ParentProcess::open(u32::MAX, birth_time).is_err());
    }

    #[test]
    fn restored_desktop_detects_exit_of_its_bound_watcher() {
        let mut command = Command::new(std::env::var("RALPH_VERIFIER_NODE").unwrap());
        command.args(["-e", "setInterval(()=>{},1000)"]);
        configure_child_process_group(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        let birth_time = ParentProcess::birth_time(child.id()).unwrap();
        let mut watcher =
            WatcherProcess::Parent(ParentProcess::open(child.id(), birth_time).unwrap());
        assert!(watcher.is_alive().unwrap());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!watcher.is_alive().unwrap());
    }
}
