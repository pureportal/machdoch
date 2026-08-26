use std::{
    fmt, io,
    ops::{Deref, DerefMut},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::{io::AsRawHandle, process::CommandExt};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    },
};

#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
#[cfg(target_os = "windows")]
const CREATE_SUSPENDED: u32 = 0x00000004;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const TERMINATION_POLL_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(unix)]
const GRACEFUL_TERMINATION_TIMEOUT: Duration = Duration::from_millis(500);
const FORCED_TERMINATION_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct ChildProcessJob {
    #[cfg(target_os = "windows")]
    handle: HANDLE,
}

#[cfg(target_os = "windows")]
impl Drop for ChildProcessJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

#[derive(Debug)]
pub(crate) enum SupervisedChildSpawnError {
    Spawn(io::Error),
    Isolation(String),
}

impl fmt::Display for SupervisedChildSpawnError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn(error) => error.fmt(formatter),
            Self::Isolation(error) => formatter.write_str(error),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum ChildCleanupKind {
    AlreadyExited,
    #[cfg(unix)]
    GracefullyTerminated,
    ForceTerminated,
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct ChildCleanupOutcome {
    pub(crate) kind: ChildCleanupKind,
    pub(crate) status: ExitStatus,
}

#[derive(Debug)]
pub(crate) enum ChildCleanupError {
    Monitor(io::Error),
    TimedOut,
}

impl fmt::Display for ChildCleanupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Monitor(error) => {
                write!(formatter, "failed to monitor the child process: {error}")
            }
            Self::TimedOut => formatter.write_str("timed out while reaping the child process"),
        }
    }
}

pub(crate) struct SupervisedChild {
    child: Child,
    job: Option<ChildProcessJob>,
    preserve_descendants_after_exit: bool,
    tree_termination_attempted: bool,
    #[cfg(test)]
    tree_termination_attempts: usize,
}

impl SupervisedChild {
    pub(crate) fn spawn(command: &mut Command) -> Result<Self, SupervisedChildSpawnError> {
        Self::spawn_with_job_requirement(command, false)
    }

    pub(crate) fn spawn_with_required_isolation(
        command: &mut Command,
    ) -> Result<Self, SupervisedChildSpawnError> {
        Self::spawn_with_job_requirement(command, true)
    }

    pub(crate) fn spawn_preserving_descendants_after_exit(
        command: &mut Command,
    ) -> Result<Self, SupervisedChildSpawnError> {
        configure_child_process_group(command);
        let child = command.spawn().map_err(SupervisedChildSpawnError::Spawn)?;
        Ok(Self {
            child,
            job: None,
            preserve_descendants_after_exit: true,
            tree_termination_attempted: false,
            #[cfg(test)]
            tree_termination_attempts: 0,
        })
    }

    fn spawn_with_job_requirement(
        command: &mut Command,
        require_job: bool,
    ) -> Result<Self, SupervisedChildSpawnError> {
        configure_supervised_child_process_group(command);
        let mut child = command.spawn().map_err(SupervisedChildSpawnError::Spawn)?;
        let job = match assign_child_process_to_kill_on_close_job(&child) {
            Ok(job) => Some(job),
            Err(error) if require_job => {
                terminate_child_process_tree(&mut child);
                let _ = wait_for_raw_child_exit(&mut child, FORCED_TERMINATION_TIMEOUT);
                return Err(SupervisedChildSpawnError::Isolation(error));
            }
            Err(_) => None,
        };

        #[cfg(target_os = "windows")]
        if let Err(error) = resume_suspended_child(&child) {
            if let Some(job) = job.as_ref() {
                unsafe {
                    let _ = TerminateJobObject(job.handle, 1);
                }
            } else {
                terminate_child_process_tree(&mut child);
            }
            let _ = wait_for_raw_child_exit(&mut child, FORCED_TERMINATION_TIMEOUT);
            return Err(SupervisedChildSpawnError::Isolation(error));
        }

        Ok(Self {
            child,
            job,
            preserve_descendants_after_exit: false,
            tree_termination_attempted: false,
            #[cfg(test)]
            tree_termination_attempts: 0,
        })
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() && !self.preserve_descendants_after_exit {
            self.terminate_tree_once();
        }
        Ok(status)
    }

    pub(crate) fn terminate_and_reap(&mut self) -> Result<ChildCleanupOutcome, ChildCleanupError> {
        match self.child.try_wait() {
            Ok(Some(status)) => {
                if !self.preserve_descendants_after_exit {
                    self.terminate_tree_once();
                }
                return Ok(ChildCleanupOutcome {
                    kind: ChildCleanupKind::AlreadyExited,
                    status,
                });
            }
            Ok(None) => {}
            Err(_) => {
                self.terminate_tree_once();
                return self
                    .wait_for_exit(FORCED_TERMINATION_TIMEOUT)
                    .and_then(|status| {
                        status
                            .map(|status| ChildCleanupOutcome {
                                kind: ChildCleanupKind::ForceTerminated,
                                status,
                            })
                            .ok_or(ChildCleanupError::TimedOut)
                    });
            }
        }

        #[cfg(unix)]
        {
            let graceful_signal_sent = signal_process_group(&self.child, "-TERM");
            if graceful_signal_sent {
                if let Some(status) = self.wait_for_exit(GRACEFUL_TERMINATION_TIMEOUT)? {
                    // The direct child may exit before a descendant that inherited its pipes.
                    self.terminate_tree_once();
                    return Ok(ChildCleanupOutcome {
                        #[cfg(unix)]
                        kind: ChildCleanupKind::GracefullyTerminated,
                        status,
                    });
                }
            }
        }

        self.terminate_tree_once();
        match self.wait_for_exit(FORCED_TERMINATION_TIMEOUT)? {
            Some(status) => Ok(ChildCleanupOutcome {
                kind: ChildCleanupKind::ForceTerminated,
                status,
            }),
            None => Err(ChildCleanupError::TimedOut),
        }
    }

    fn wait_for_exit(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<ExitStatus>, ChildCleanupError> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => return Ok(Some(status)),
                Ok(None) if Instant::now() < deadline => thread::sleep(TERMINATION_POLL_INTERVAL),
                Ok(None) => return Ok(None),
                Err(error) => return Err(ChildCleanupError::Monitor(error)),
            }
        }
    }

    fn terminate_tree_once(&mut self) {
        if self.tree_termination_attempted {
            return;
        }
        self.tree_termination_attempted = true;
        #[cfg(test)]
        {
            self.tree_termination_attempts += 1;
        }

        #[cfg(target_os = "windows")]
        unsafe {
            if let Some(job) = self.job.as_ref() {
                if TerminateJobObject(job.handle, 1).is_ok() {
                    return;
                }
            }
        }

        #[cfg(target_os = "windows")]
        if terminate_child_process_tree_by_id(self.child.id()) {
            return;
        }

        #[cfg(unix)]
        if signal_process_group(&self.child, "-KILL") {
            return;
        }

        let _ = self.child.kill();
    }
}

fn wait_for_raw_child_exit(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(TERMINATION_POLL_INTERVAL),
            Ok(None) | Err(_) => return None,
        }
    }
}

impl Deref for SupervisedChild {
    type Target = Child;

    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl DerefMut for SupervisedChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        let _ = self.terminate_and_reap();
    }
}

pub(crate) fn configure_child_process_group(command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    #[cfg(unix)]
    {
        command.process_group(0);
    }
}

fn configure_supervised_child_process_group(command: &mut Command) {
    configure_child_process_group(command);

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
    }
}

#[cfg(target_os = "windows")]
fn resume_suspended_child(child: &Child) -> Result<(), String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
            .map_err(|error| format!("Failed to inspect the suspended child process: {error}"))?;
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut current = Thread32First(snapshot, &mut entry);
        let mut result = Err("Failed to find the suspended child process thread".to_string());

        while current.is_ok() {
            if entry.th32OwnerProcessID == child.id() {
                result = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                    .map_err(|error| {
                        format!("Failed to open the suspended child process thread: {error}")
                    })
                    .and_then(|thread_handle| {
                        let resume_result = ResumeThread(thread_handle);
                        let _ = CloseHandle(thread_handle);
                        if resume_result == u32::MAX {
                            Err(format!(
                                "Failed to resume the isolated child process: {}",
                                windows::core::Error::from_win32()
                            ))
                        } else {
                            Ok(())
                        }
                    });
                break;
            }
            current = Thread32Next(snapshot, &mut entry);
        }

        let _ = CloseHandle(snapshot);
        result
    }
}

pub(crate) fn assign_child_process_to_kill_on_close_job(
    child: &Child,
) -> Result<ChildProcessJob, String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let handle = CreateJobObjectW(None, PCWSTR::null())
            .map_err(|error| format!("Failed to create the child process job object: {error}"))?;
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        if let Err(error) = SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = CloseHandle(handle);
            return Err(format!(
                "Failed to configure the child process job object: {error}"
            ));
        }

        let process_handle = HANDLE(child.as_raw_handle());
        if let Err(error) = AssignProcessToJobObject(handle, process_handle) {
            let _ = CloseHandle(handle);
            return Err(format!(
                "Failed to assign the child process to its job object: {error}"
            ));
        }

        Ok(ChildProcessJob { handle })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = child;
        Ok(ChildProcessJob {})
    }
}

#[cfg(unix)]
fn signal_process_group(child: &Child, signal: &str) -> bool {
    let process_group_id = format!("-{}", child.id());
    Command::new("kill")
        .args([signal, process_group_id.as_str()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(crate) fn terminate_child_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        if terminate_child_process_tree_by_id(child.id()) {
            return;
        }
    }

    #[cfg(unix)]
    {
        if signal_process_group(child, "-TERM") {
            for _ in 0..10 {
                if !process_group_exists(child) {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            let _ = signal_process_group(child, "-KILL");
            return;
        }
    }

    let _ = child.kill();
}

impl ChildProcessJob {
    pub(crate) fn terminate(&self) -> bool {
        #[cfg(target_os = "windows")]
        unsafe {
            TerminateJobObject(self.handle, 1).is_ok()
        }

        #[cfg(not(target_os = "windows"))]
        false
    }
}

#[cfg(unix)]
fn process_group_exists(child: &Child) -> bool {
    signal_process_group(child, "-0")
}

#[cfg(target_os = "windows")]
pub(crate) fn terminate_child_process_tree_by_id(process_id: u32) -> bool {
    let pid = process_id.to_string();
    let mut command = Command::new("taskkill");
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        sync::atomic::{AtomicU64, Ordering},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[cfg(target_os = "windows")]
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    use super::{configure_child_process_group, ChildCleanupKind, SupervisedChild};

    const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_CHILD_PROCESS_TEST_MODE";
    const TEST_DESCENDANT_PID_PATH_ENV: &str = "MACHDOCH_CHILD_PROCESS_TEST_PID_PATH";
    static NEXT_TEST_PATH_ID: AtomicU64 = AtomicU64::new(0);

    struct TestPath(PathBuf);

    impl TestPath {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let sequence = NEXT_TEST_PATH_ID.fetch_add(1, Ordering::Relaxed);
            Self(env::temp_dir().join(format!(
                "machdoch-child-process-test-{}-{timestamp}-{sequence}.pid",
                std::process::id()
            )))
        }
    }

    impl Drop for TestPath {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn test_child_command(mode: &str) -> Command {
        let mut command = Command::new(env::current_exe().expect("test executable should resolve"));
        command
            .arg("--exact")
            .arg("child_process::tests::child_process_supervision_test_entrypoint")
            .arg("--nocapture")
            .env(TEST_CHILD_MODE_ENV, mode);
        command
    }

    #[test]
    fn child_process_supervision_test_entrypoint() {
        match env::var(TEST_CHILD_MODE_ENV).as_deref() {
            Ok("exit") => {}
            Ok("short") => thread::sleep(Duration::from_millis(75)),
            Ok("hold") => thread::sleep(Duration::from_secs(60)),
            Ok("ignore-term") => {
                #[cfg(unix)]
                unsafe {
                    libc::signal(libc::SIGTERM, libc::SIG_IGN);
                }
                thread::sleep(Duration::from_secs(60));
            }
            Ok("spawn-descendant") | Ok("spawn-descendant-and-exit") => {
                let pid_path = env::var_os(TEST_DESCENDANT_PID_PATH_ENV)
                    .map(PathBuf::from)
                    .expect("descendant pid path should be provided");
                let mut descendant = test_child_command("hold");
                descendant
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                let descendant = descendant
                    .spawn()
                    .expect("descendant test process should start");
                fs::write(pid_path, descendant.id().to_string())
                    .expect("descendant pid should be recorded");
                drop(descendant);

                if env::var(TEST_CHILD_MODE_ENV).as_deref() == Ok("spawn-descendant") {
                    thread::sleep(Duration::from_secs(60));
                }
            }
            _ => {}
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn direct_process_group_configuration_does_not_suspend_child() {
        let mut command = test_child_command("exit");
        configure_child_process_group(&mut command);
        let mut child = command.spawn().expect("direct test child should start");
        let deadline = Instant::now() + Duration::from_secs(3);

        loop {
            match child
                .try_wait()
                .expect("direct child should remain observable")
            {
                Some(status) => {
                    assert!(status.success());
                    break;
                }
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => {
                    super::terminate_child_process_tree(&mut child);
                    let _ = child.wait();
                    panic!("direct process-group child remained suspended");
                }
            }
        }
    }

    fn wait_for_descendant_pid(path: &Path) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(pid) = fs::read_to_string(path) {
                return pid
                    .parse::<u32>()
                    .expect("recorded descendant pid should be numeric");
            }
            assert!(
                Instant::now() < deadline,
                "descendant pid was not recorded before the test deadline"
            );
            thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(target_os = "windows")]
    fn process_is_alive(pid: u32) -> bool {
        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(handle) => {
                    let mut exit_code = 0_u32;
                    let alive =
                        GetExitCodeProcess(handle, &mut exit_code).is_ok() && exit_code == 259;
                    let _ = CloseHandle(handle);
                    alive
                }
                Err(_) => false,
            }
        }
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    fn assert_process_stops(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while process_is_alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!process_is_alive(pid), "descendant process {pid} survived");
    }

    fn stop_test_process(pid: u32) {
        #[cfg(target_os = "windows")]
        {
            super::terminate_child_process_tree_by_id(pid);
        }

        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }

    struct TestProcessGuard(Option<u32>);

    impl TestProcessGuard {
        fn stop(mut self) {
            let pid = self.0.take().expect("test process should be available");
            stop_test_process(pid);
            assert_process_stops(pid);
        }
    }

    impl Drop for TestProcessGuard {
        fn drop(&mut self) {
            if let Some(pid) = self.0.take() {
                stop_test_process(pid);
            }
        }
    }

    #[test]
    fn supervised_child_preserves_natural_exit_status() {
        let mut child = SupervisedChild::spawn(&mut test_child_command("exit"))
            .expect("supervised test child should start");
        let status = loop {
            if let Some(status) = child.try_wait().expect("child should remain observable") {
                break status;
            }
            thread::sleep(Duration::from_millis(10));
        };

        assert!(status.success());
        let cleanup = child
            .terminate_and_reap()
            .expect("already-exited cleanup should succeed");
        assert_eq!(cleanup.kind, ChildCleanupKind::AlreadyExited);
        assert_eq!(cleanup.status.code(), status.code());
    }

    #[test]
    fn supervised_child_forcibly_terminates_and_reaps() {
        let mut child = SupervisedChild::spawn(&mut test_child_command("hold"))
            .expect("supervised test child should start");
        let cleanup = child
            .terminate_and_reap()
            .expect("running child should be terminated and reaped");

        assert_ne!(cleanup.kind, ChildCleanupKind::AlreadyExited);
        assert!(!cleanup.status.success());
    }

    #[cfg(unix)]
    #[test]
    fn supervised_child_escalates_when_graceful_termination_is_ignored() {
        let mut child = SupervisedChild::spawn(&mut test_child_command("ignore-term"))
            .expect("supervised test child should start");
        thread::sleep(Duration::from_millis(100));
        let cleanup = child
            .terminate_and_reap()
            .expect("uncooperative child should be forcibly terminated");

        assert_eq!(cleanup.kind, ChildCleanupKind::ForceTerminated);
    }

    #[test]
    fn supervised_child_termination_stops_descendants() {
        let pid_path = TestPath::new();
        let mut command = test_child_command("spawn-descendant");
        command.env(TEST_DESCENDANT_PID_PATH_ENV, &pid_path.0);
        let mut child = SupervisedChild::spawn_with_required_isolation(&mut command)
            .expect("supervised descendant parent should start");
        let descendant_pid = wait_for_descendant_pid(&pid_path.0);

        child
            .terminate_and_reap()
            .expect("process tree should be terminated and reaped");
        assert_process_stops(descendant_pid);
    }

    #[test]
    fn natural_parent_exit_stops_residual_descendants() {
        let pid_path = TestPath::new();
        let mut command = test_child_command("spawn-descendant-and-exit");
        command.env(TEST_DESCENDANT_PID_PATH_ENV, &pid_path.0);
        let mut child = SupervisedChild::spawn_with_required_isolation(&mut command)
            .expect("supervised descendant parent should start");
        let descendant_pid = wait_for_descendant_pid(&pid_path.0);
        let status = loop {
            if let Some(status) = child.try_wait().expect("parent should remain observable") {
                break status;
            }
            thread::sleep(Duration::from_millis(10));
        };

        assert!(status.success());
        assert_process_stops(descendant_pid);
    }

    #[test]
    fn persistent_descendant_mode_preserves_descendants_after_parent_exit() {
        let pid_path = TestPath::new();
        let mut command = test_child_command("spawn-descendant-and-exit");
        command.env(TEST_DESCENDANT_PID_PATH_ENV, &pid_path.0);
        let mut child = SupervisedChild::spawn_preserving_descendants_after_exit(&mut command)
            .expect("persistent-descendant parent should start");
        let descendant_pid = wait_for_descendant_pid(&pid_path.0);
        let guard = TestProcessGuard(Some(descendant_pid));
        let status = loop {
            if let Some(status) = child.try_wait().expect("parent should remain observable") {
                break status;
            }
            thread::sleep(Duration::from_millis(10));
        };

        assert!(status.success());
        assert!(process_is_alive(descendant_pid));
        guard.stop();
    }

    #[test]
    fn supervised_child_cleanup_is_repeatable() {
        let mut child = SupervisedChild::spawn(&mut test_child_command("hold"))
            .expect("supervised test child should start");
        child
            .terminate_and_reap()
            .expect("initial cleanup should succeed");
        assert_eq!(child.tree_termination_attempts, 1);
        let repeated = child
            .terminate_and_reap()
            .expect("repeated cleanup should be idempotent");

        assert_eq!(repeated.kind, ChildCleanupKind::AlreadyExited);
        assert_eq!(child.tree_termination_attempts, 1);
    }

    #[test]
    fn cancellation_race_with_natural_exit_is_idempotent() {
        let mut child = SupervisedChild::spawn(&mut test_child_command("short"))
            .expect("supervised test child should start");
        thread::sleep(Duration::from_millis(50));

        child
            .terminate_and_reap()
            .expect("racing cleanup should succeed");
        assert_eq!(
            child
                .terminate_and_reap()
                .expect("post-race cleanup should remain idempotent")
                .kind,
            ChildCleanupKind::AlreadyExited
        );
    }
}
