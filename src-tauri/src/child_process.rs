use std::process::{Child, Command, Stdio};

#[cfg(unix)]
use std::{thread, time::Duration};

#[cfg(target_os = "windows")]
use std::os::windows::{io::AsRawHandle, process::CommandExt};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    },
};

#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

        return Ok(ChildProcessJob { handle });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = child;
        Ok(ChildProcessJob {})
    }
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
        let process_group_id = format!("-{}", child.id());
        let kill_result = Command::new("kill")
            .args(["-TERM", process_group_id.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        if kill_result.map(|status| status.success()).unwrap_or(false) {
            for _ in 0..10 {
                if child.try_wait().ok().flatten().is_some() {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            let _ = Command::new("kill")
                .args(["-KILL", process_group_id.as_str()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            return;
        }
    }

    let _ = child.kill();
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
