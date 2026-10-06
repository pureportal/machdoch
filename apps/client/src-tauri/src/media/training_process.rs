use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Manager};

use crate::child_process::{terminate_child_process_tree_by_id, SupervisedChild};

use super::super::{provider_local_diffusers, runtime_setup};
use super::{MediaResult, MediaRuntimePaths, RunnerStatus};

fn runner_script(app: &AppHandle) -> MediaResult<PathBuf> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("python")
        .join("media_training.py");
    if resource.is_file() {
        return Ok(resource);
    }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("media_training.py");
        if development.is_file() {
            return Ok(development);
        }
    }
    Err("The local trainer is missing. Reinstall Media Studio.".into())
}

pub(super) fn process_for_job(directory: &Path) -> MediaResult<Option<(System, Pid)>> {
    let pid: u32 = match fs::read_to_string(directory.join("pid")) {
        Ok(value) => value
            .trim()
            .parse()
            .map_err(|_| "Training process ID is invalid.")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read training process ID: {error}")),
    };
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let Some(process) = system.process(pid) else {
        return Ok(None);
    };
    let expected = directory.to_string_lossy();
    if !process
        .cmd()
        .iter()
        .any(|argument| argument.to_string_lossy() == expected)
    {
        return Ok(None);
    }
    Ok(Some((system, pid)))
}

pub(super) fn start_process(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    directory: &Path,
) -> MediaResult<()> {
    let runtime = provider_local_diffusers::probe(app);
    if !runtime.ready {
        return Err(format!(
            "Local training is unavailable: {}",
            runtime.diagnostic
        ));
    }
    let python = runtime_setup::python_path(&runtime_setup::root(app)?);
    if !python.is_file() {
        return Err("Install the Media Studio local model runtime before training.".into());
    }
    let script = runner_script(app)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("training.log"))
        .map_err(|error| format!("Could not open training log: {error}"))?;
    let error_log = log.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(python);
    command
        .arg("-I")
        .arg("-B")
        .arg("-Xutf8")
        .arg(script)
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(error_log)
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_DATASETS_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("WANDB_DISABLED", "true")
        .env("DO_NOT_TRACK", "1")
        .env_remove("HF_TOKEN")
        .env_remove("HUGGING_FACE_HUB_TOKEN")
        .env_remove("WANDB_API_KEY");
    provider_local_diffusers::configure_preferred_gpu(&mut command);
    super::super::model_memory::release_idle()?;
    fs::write(
        directory.join("status.json"),
        serde_json::to_vec(&RunnerStatus {
            state: "starting".into(),
            message: None,
        })
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Could not save training status: {error}"))?;
    let (started, receiver) = std::sync::mpsc::sync_channel(1);
    let storage_lease = paths.clone();
    std::thread::spawn(move || {
        let _storage_lease = storage_lease;
        let mut child = match SupervisedChild::spawn(&mut command) {
            Ok(child) => child,
            Err(error) => {
                let _ = started.send(Err(format!("Could not start local training: {error}")));
                return;
            }
        };
        if started.send(Ok(child.id())).is_err() {
            return;
        }
        let _ = child.wait();
    });
    let pid = receiver
        .recv()
        .map_err(|error| format!("Could not start local training: {error}"))??;
    if let Err(error) = fs::write(directory.join("pid"), pid.to_string()) {
        terminate_child_process_tree_by_id(pid);
        return Err(format!("Could not save training process ID: {error}"));
    }
    Ok(())
}
