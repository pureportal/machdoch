mod download;
pub(super) mod installer;
mod process;
#[cfg(test)]
mod tests;

use std::{collections::HashMap, path::PathBuf, sync::RwLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::{
    error::{command_result, MediaCommandResult},
    provider_local_diffusers, MediaResult, MediaRuntimeState,
};

pub(crate) use installer::python_path;
pub(crate) static RUNTIME_USE: RwLock<()> = RwLock::new(());

const MAX_DIAGNOSTIC_CHARS: usize = 8000;
const OUTPUT_OMITTED: &str = "\n... output omitted ...\n";

fn retain_diagnostic_context(diagnostic: &str, limit: usize) -> String {
    let count = diagnostic.chars().count();
    if count <= limit {
        return diagnostic.to_string();
    }
    let retained = limit.saturating_sub(OUTPUT_OMITTED.chars().count());
    let start = retained.div_ceil(2);
    let end = retained / 2;
    diagnostic
        .chars()
        .take(start)
        .chain(OUTPUT_OMITTED.chars().take(limit))
        .chain(diagnostic.chars().skip(count - end))
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    python_version: String,
    uv_version: String,
    installers: HashMap<String, InstallerArchive>,
    accelerators: HashMap<String, AcceleratorBundle>,
}

#[derive(Deserialize)]
struct InstallerArchive {
    archive: String,
    sha256: String,
    executable: String,
}

#[derive(Deserialize)]
struct AcceleratorBundle {
    torch: String,
    torchvision: String,
    index: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SetupPhase {
    #[default]
    Idle,
    Checking,
    Downloading,
    Python,
    Dependencies,
    Verifying,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupStatus {
    pub(crate) phase: SetupPhase,
    pub(crate) download_percent: Option<u8>,
    pub(crate) message: String,
    pub(crate) diagnostic: Option<String>,
}

impl SetupStatus {
    fn running(phase: SetupPhase) -> Self {
        Self {
            phase,
            ..Self::default()
        }
    }

    pub(crate) fn active(&self) -> bool {
        !matches!(
            self.phase,
            SetupPhase::Idle | SetupPhase::Ready | SetupPhase::Failed
        )
    }

    fn failed(diagnostic: String) -> Self {
        let lower = diagnostic.to_ascii_lowercase();
        let message = if lower.contains("no space")
            || lower.contains("disk full")
            || lower.contains("os error 112")
        {
            "Setup ran out of space. Free up disk space, then retry setup."
        } else if lower.contains("another media studio setup") {
            "Setup is running in another window. Wait for it to finish, then retry."
        } else if lower.contains("bundled") && lower.contains("missing") {
            "Media Studio files are missing. Reinstall Machdoch, then retry setup."
        } else if lower.contains("not supported on") {
            "Setup is not available for this computer. Use a supported desktop to run local models."
        } else if lower.contains("permission denied") || lower.contains("access is denied") {
            "Setup could not save its files. Check access to the app data folder, then retry setup."
        } else if lower.contains("download")
            || lower.contains("network")
            || lower.contains("connect")
        {
            "Setup could not finish downloading. Check your connection, then retry setup."
        } else if lower.contains("timed out") {
            "Setup took too long. Retry setup."
        } else if lower.contains("graphics")
            || lower.contains("cuda")
            || lower.contains("hip error")
        {
            "Setup could not use your graphics card. Update its driver, then retry setup."
        } else {
            "Setup could not finish. Retry setup. If it fails again, open the details."
        };
        Self {
            phase: SetupPhase::Failed,
            message: message.to_string(),
            diagnostic: Some(retain_diagnostic_context(&diagnostic, MAX_DIAGNOSTIC_CHARS)),
            download_percent: None,
        }
    }
}

pub(crate) fn root(app: &AppHandle) -> MediaResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|root| root.join("media-studio").join("runtime"))
        .map_err(|error| format!("Could not locate Media Studio setup: {error}"))
}

fn update(app: &AppHandle, status: SetupStatus) {
    let state = app.state::<MediaRuntimeState>();
    *state
        .runtime_setup
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = status;
}

fn setup(app: &AppHandle) -> MediaResult<()> {
    let runtime = installer::install(
        &root(app)?,
        &provider_local_diffusers::worker_script(app)?,
        |status| update(app, status),
    )?;
    *app.state::<MediaRuntimeState>()
        .local_diffusers_status
        .lock()
        .map_err(|_| "Media runtime status is unavailable")? = Some(runtime);
    update(app, SetupStatus::running(SetupPhase::Ready));
    Ok(())
}

#[tauri::command]
pub(crate) fn media_get_runtime_setup(app: AppHandle) -> MediaCommandResult<SetupStatus> {
    command_result(
        "media_get_runtime_setup",
        app.state::<MediaRuntimeState>()
            .runtime_setup
            .lock()
            .map(|status| status.clone())
            .map_err(|_| "Media setup status is unavailable".to_string()),
    )
}

#[tauri::command]
pub(crate) fn media_start_runtime_setup(app: AppHandle) -> MediaCommandResult<SetupStatus> {
    let result = (|| {
        let state = app.state::<MediaRuntimeState>();
        let mut status = state
            .runtime_setup
            .lock()
            .map_err(|_| "Media setup status is unavailable")?;
        if status.active() {
            return Ok(status.clone());
        }
        if state.active_count() > 0 {
            *status = SetupStatus {
                phase: SetupPhase::Failed,
                message: "Wait for Media Studio jobs to finish, then retry setup.".to_string(),
                ..SetupStatus::default()
            };
            return Ok(status.clone());
        }
        *status = SetupStatus::running(SetupPhase::Checking);
        let worker_app = app.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("media-runtime-setup".to_string())
            .spawn(move || {
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| setup(&worker_app)))
                        .unwrap_or_else(|_| {
                            Err("Media Studio setup stopped unexpectedly".to_string())
                        });
                if let Err(error) = result {
                    *worker_app
                        .state::<MediaRuntimeState>()
                        .local_diffusers_status
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                    update(&worker_app, SetupStatus::failed(error));
                }
            })
        {
            *status = SetupStatus::failed(format!("Could not start setup: {error}"));
        }
        Ok(status.clone())
    })();
    command_result("media_start_runtime_setup", result)
}
