use machdoch_process::{SupervisedChild, SupervisedChildSpawnError};
use std::process::{Command, ExitStatus};

pub type IsolatedChild = SupervisedChild;

pub struct Configuration;
impl Configuration {
    pub fn new(_: &str, cgroup_root: Option<&str>) -> Result<Self, String> {
        if cgroup_root.is_some() {
            return Err("Windows supervision does not accept a cgroup root".to_string());
        }
        Ok(Self)
    }
}

pub fn spawn(
    command: &mut Command,
    memory: usize,
    _: &Configuration,
) -> Result<IsolatedChild, SupervisedChildSpawnError> {
    SupervisedChild::spawn_with_job_limits(command, memory, 128, 2)
}

pub fn stop(child: &mut IsolatedChild) -> Result<ExitStatus, String> {
    let status = child
        .terminate_and_reap()
        .map_err(|error| error.to_string())?
        .status;
    child.confirm_isolation_stopped()?;
    Ok(status)
}
