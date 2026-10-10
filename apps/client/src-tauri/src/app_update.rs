use crate::cooperative_file_lock::{acquire_cooperative_file_lock, CooperativeFileLock};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tauri::{
    utils::platform::{bundle_type, current_exe},
    AppHandle, Manager as _,
};

#[derive(Default)]
pub(crate) struct AppUpdateState(Mutex<Option<CooperativeFileLock>>);

#[tauri::command]
pub(crate) fn app_update_available() -> bool {
    !cfg!(debug_assertions) && bundle_type().is_some()
}

#[tauri::command]
pub(crate) async fn prepare_app_update(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !app_update_available() {
            return Err("Updates require an installed release build.".to_string());
        }
        if crate::idle_shutdown::has_pending_shutdown_work(app.clone())? {
            return Err(
                "Wait for running work to finish before installing the update.".to_string(),
            );
        }
        let state = app.state::<AppUpdateState>();
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Update state is unavailable.".to_string())?;
        if guard.is_none() {
            let executable = if cfg!(target_os = "linux") {
                std::env::var_os("APPIMAGE")
                    .map(std::path::PathBuf::from)
                    .map(Ok)
                    .unwrap_or_else(current_exe)
            } else {
                current_exe()
            }
            .map_err(|error| error.to_string())?;
            let executable =
                std::fs::canonicalize(executable).map_err(|error| error.to_string())?;
            let identity = executable.to_string_lossy();
            let identity = identity.strip_prefix("\\\\?\\").unwrap_or(&identity);
            let identity = if cfg!(windows) {
                identity.to_lowercase()
            } else {
                identity.to_string()
            };
            let lock_path = std::env::temp_dir().join(format!(
                "machdoch-update-{:x}",
                Sha256::digest(identity.as_bytes())
            ));
            *guard = Some(
                acquire_cooperative_file_lock(&lock_path)
                    .map_err(|error| format!("Another update may be running. {error}"))?,
            );
        }
        crate::idle_shutdown::disable_shutdown_when_idle(&app)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn finish_app_update(app: AppHandle) -> Result<(), String> {
    app.state::<AppUpdateState>()
        .0
        .lock()
        .map_err(|_| "Update state is unavailable.".to_string())?
        .take();
    Ok(())
}
