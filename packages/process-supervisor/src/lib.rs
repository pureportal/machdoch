use std::{
    fmt, io,
    ops::{Deref, DerefMut},
    process::{Child, Command, ExitStatus},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::process::Stdio;

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
                AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
                JobObjectCpuRateControlInformation, JobObjectExtendedLimitInformation,
                QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
                JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_CPU_RATE_CONTROL_ENABLE, JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                GetActiveProcessorCount, OpenThread, ResumeThread, ALL_PROCESSOR_GROUPS,
                THREAD_SUSPEND_RESUME,
            },
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

pub struct ChildProcessJob {
    #[cfg(target_os = "windows")]
    handle: HANDLE,
}

// A job object handle is valid on every thread of the owning process.
#[cfg(target_os = "windows")]
unsafe impl Send for ChildProcessJob {}

#[cfg(target_os = "windows")]
impl Drop for ChildProcessJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

#[derive(Debug)]
pub enum SupervisedChildSpawnError {
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
pub enum ChildCleanupKind {
    AlreadyExited,
    #[cfg(unix)]
    GracefullyTerminated,
    ForceTerminated,
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct ChildCleanupOutcome {
    pub kind: ChildCleanupKind,
    pub status: ExitStatus,
}

#[derive(Debug)]
pub enum ChildCleanupError {
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

pub struct SupervisedChild {
    child: Child,
    job: Option<ChildProcessJob>,
    preserve_descendants_after_exit: bool,
    tree_termination_attempted: bool,
    #[cfg(test)]
    tree_termination_attempts: usize,
}

impl SupervisedChild {
    #[cfg(windows)]
    pub fn confirm_isolation_stopped(&self) -> Result<(), String> {
        let job = self.job.as_ref().ok_or("Process job is unavailable")?;
        let deadline = Instant::now() + FORCED_TERMINATION_TIMEOUT;
        loop {
            let mut information = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    Some(job.handle),
                    JobObjectBasicAccountingInformation,
                    (&mut information as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    None,
                )
                .map_err(|error| format!("Failed to inspect process job: {error}"))?;
            }
            if information.ActiveProcesses == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Process job still contains active processes".to_string());
            }
            thread::sleep(TERMINATION_POLL_INTERVAL);
        }
    }
    #[cfg(windows)]
    pub fn spawn_with_job_limits(
        command: &mut Command,
        memory_bytes: usize,
        processes: u32,
        cpu_cores: u32,
    ) -> Result<Self, SupervisedChildSpawnError> {
        if memory_bytes == 0 || processes == 0 || cpu_cores == 0 {
            return Err(SupervisedChildSpawnError::Spawn(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid process job limits",
            )));
        }
        let processors = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
        if processors == 0 {
            return Err(SupervisedChildSpawnError::Spawn(io::Error::other(
                "Cannot determine CPU capacity",
            )));
        }
        let requested_rate = u64::from(cpu_cores) * 10000 / u64::from(processors);
        if requested_rate == 0 {
            return Err(SupervisedChildSpawnError::Spawn(io::Error::other(
                "The requested CPU limit is below the platform's rate resolution",
            )));
        }
        let cpu_rate = requested_rate.min(10000) as u32;
        Self::spawn_with_job_requirement(command, true, |job| {
            let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_JOB_MEMORY
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            information.BasicLimitInformation.ActiveProcessLimit = processes;
            information.JobMemoryLimit = memory_bytes;
            let cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
                ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE
                    | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 { CpuRate: cpu_rate },
            };
            unsafe {
                SetInformationJobObject(
                    job.handle,
                    JobObjectExtendedLimitInformation,
                    (&information as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|error| format!("Failed to set process job limits: {error}"))?;
                SetInformationJobObject(
                    job.handle,
                    JobObjectCpuRateControlInformation,
                    (&cpu as *const JOBOBJECT_CPU_RATE_CONTROL_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
                )
                .map_err(|error| format!("Failed to set process CPU limit: {error}"))
            }
        })
    }
    pub fn spawn(command: &mut Command) -> Result<Self, SupervisedChildSpawnError> {
        Self::spawn_with_job_requirement(command, false, |_| Ok(()))
    }

    pub fn spawn_with_required_isolation(
        command: &mut Command,
    ) -> Result<Self, SupervisedChildSpawnError> {
        Self::spawn_with_job_requirement(command, true, |_| Ok(()))
    }

    pub fn spawn_preserving_descendants_after_exit(
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
        configure_job: impl FnOnce(&ChildProcessJob) -> Result<(), String>,
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

        if let Some(job) = job.as_ref() {
            if let Err(error) = configure_job(job) {
                if !job.terminate() {
                    terminate_child_process_tree(&mut child);
                }
                let _ = wait_for_raw_child_exit(&mut child, FORCED_TERMINATION_TIMEOUT);
                return Err(SupervisedChildSpawnError::Isolation(error));
            }
        }

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

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() && !self.preserve_descendants_after_exit {
            self.terminate_tree_once();
        }
        Ok(status)
    }

    pub fn terminate_and_reap(&mut self) -> Result<ChildCleanupOutcome, ChildCleanupError> {
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
            let graceful_signal_sent = signal_process_group(&self.child, libc::SIGTERM);
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
        if signal_process_group(&self.child, libc::SIGKILL) {
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

pub fn configure_child_process_group(command: &mut Command) {
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

pub fn assign_child_process_to_kill_on_close_job(child: &Child) -> Result<ChildProcessJob, String> {
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
fn signal_process_group(child: &Child, signal: i32) -> bool {
    let Ok(pid) = i32::try_from(child.id()) else {
        return false;
    };
    // Never let an invalid group id target Machdoch's own process group.
    pid > 0 && unsafe { libc::kill(-pid, signal) == 0 }
}

pub fn terminate_child_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        if terminate_child_process_tree_by_id(child.id()) {
            return;
        }
    }

    #[cfg(unix)]
    {
        if signal_process_group(child, libc::SIGTERM) {
            for _ in 0..10 {
                if !process_group_exists(child) {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            let _ = signal_process_group(child, libc::SIGKILL);
            return;
        }
    }

    let _ = child.kill();
}

impl ChildProcessJob {
    pub fn terminate(&self) -> bool {
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
    signal_process_group(child, 0)
}

#[cfg(target_os = "windows")]
pub fn terminate_child_process_tree_by_id(process_id: u32) -> bool {
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

#[cfg(unix)]
pub fn terminate_child_process_tree_by_id(process_id: u32) -> bool {
    let Ok(process_group) = i32::try_from(process_id) else {
        return false;
    };
    process_group > 0 && unsafe { libc::kill(-process_group, libc::SIGKILL) == 0 }
}

#[cfg(test)]
mod tests;
