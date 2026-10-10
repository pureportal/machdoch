use std::{collections::HashSet, sync::Mutex};

use tauri::{AppHandle, Emitter as _, Manager as _};

mod chat_work;
#[cfg(any(target_os = "windows", test))]
mod command;
mod mode;
use mode::ShutdownMode;

#[derive(Default)]
pub(crate) struct IdleShutdownState {
    mode: Mutex<ShutdownMode>,
    pending_media_windows: Mutex<HashSet<String>>,
    pending_chat_windows: Mutex<HashSet<String>>,
}

impl IdleShutdownState {
    fn clear_window(&self, label: &str) -> Result<bool, String> {
        let mut mode = self
            .mode
            .lock()
            .map_err(|_| "Shutdown state is unavailable.")?;
        let mut media = self
            .pending_media_windows
            .lock()
            .map_err(|_| "Media activity is unavailable.")?;
        let mut chats = self
            .pending_chat_windows
            .lock()
            .map_err(|_| "Chat activity is unavailable.")?;
        let had_media = media.remove(label);
        let had_chat = chats.remove(label);
        let disarmed = mode.enabled && (had_media || had_chat);
        if disarmed {
            mode.set_enabled(false)?;
        }
        Ok(disarmed)
    }
}

#[tauri::command]
pub(crate) fn supports_idle_shutdown() -> bool {
    cfg!(target_os = "windows")
}

#[tauri::command]
pub(crate) fn set_shutdown_when_idle(
    app: AppHandle,
    state: tauri::State<'_, IdleShutdownState>,
    enabled: bool,
    expected_generation: u64,
) -> Result<ShutdownMode, String> {
    if enabled && !supports_idle_shutdown() {
        return Err("PC shutdown is only available on Windows.".to_string());
    }
    change_mode(&app, &state, enabled, Some(expected_generation))
}

fn publish_mode(app: &AppHandle, mode: ShutdownMode) {
    if let Err(error) = app.emit("shutdown-when-idle-changed", mode) {
        eprintln!("Could not publish shutdown mode: {error}");
    }
}

pub(crate) fn disable_shutdown_when_idle(app: &AppHandle) -> Result<(), String> {
    change_mode(app, &app.state::<IdleShutdownState>(), false, None).map(|_| ())
}

fn change_mode(
    app: &AppHandle,
    state: &IdleShutdownState,
    enabled: bool,
    expected_generation: Option<u64>,
) -> Result<ShutdownMode, String> {
    let mut mode = state
        .mode
        .lock()
        .map_err(|_| "Shutdown state is unavailable.")?;
    match expected_generation {
        Some(expected) => {
            if !mode.set_enabled_if_current(enabled, expected)? {
                return Ok(*mode);
            }
        }
        None => mode.set_enabled(enabled)?,
    }
    publish_mode(app, *mode);
    Ok(*mode)
}

#[tauri::command]
pub(crate) fn get_shutdown_when_idle(
    state: tauri::State<'_, IdleShutdownState>,
) -> Result<ShutdownMode, String> {
    state
        .mode
        .lock()
        .map(|mode| *mode)
        .map_err(|_| "Shutdown state is unavailable.".to_string())
}

#[tauri::command]
pub(crate) fn set_window_pending_media_work(
    app: AppHandle,
    window: tauri::Window,
    pending: bool,
) -> Result<(), String> {
    let state = app.state::<IdleShutdownState>();
    let mut windows = state
        .pending_media_windows
        .lock()
        .map_err(|_| "Media activity is unavailable.")?;
    if pending && !windows.contains(window.label()) {
        let _activity = app
            .state::<crate::sleep_inhibition::SystemSleepInhibitor>()
            .acquire()?;
        windows.insert(window.label().to_string());
    } else if !pending {
        windows.remove(window.label());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn set_window_pending_chat_work(
    app: AppHandle,
    window: tauri::Window,
    pending: bool,
) -> Result<(), String> {
    let state = app.state::<IdleShutdownState>();
    let mut windows = state
        .pending_chat_windows
        .lock()
        .map_err(|_| "Chat activity is unavailable.")?;
    if pending && !windows.contains(window.label()) {
        let _activity = app
            .state::<crate::sleep_inhibition::SystemSleepInhibitor>()
            .acquire()?;
        windows.insert(window.label().to_string());
    } else if !pending {
        windows.remove(window.label());
    }
    Ok(())
}

pub(crate) fn clear_window_work(app: &AppHandle, label: &str) {
    match app.state::<IdleShutdownState>().clear_window(label) {
        Ok(true) => match get_shutdown_when_idle(app.state::<IdleShutdownState>()) {
            Ok(mode) => publish_mode(app, mode),
            Err(error) => eprintln!("Could not inspect shutdown mode: {error}"),
        },
        Ok(false) => {}
        Err(error) => eprintln!("Could not clear activity for closed window: {error}"),
    }
}

fn has_pending_native_work(app: &AppHandle) -> Result<bool, String> {
    Ok(!crate::desktop_task::active_task_ids(
        &app.state::<crate::desktop_task::DesktopTaskCancelMap>(),
    )?
    .is_empty()
        || crate::media::has_pending_shutdown_work(app)?)
}

#[tauri::command]
pub(crate) fn has_pending_shutdown_work(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<IdleShutdownState>();
    let windows = state
        .pending_media_windows
        .lock()
        .map_err(|_| "Media activity is unavailable.")?;
    let chats = state
        .pending_chat_windows
        .lock()
        .map_err(|_| "Chat activity is unavailable.")?;
    Ok(!windows.is_empty() || !chats.is_empty() || has_pending_native_work(&app)?)
}

#[tauri::command]
pub(crate) async fn shutdown_if_idle(
    app: AppHandle,
    expected_revision: u64,
    expected_generation: u64,
) -> Result<bool, String> {
    let settings = crate::runtime_snapshot::get_user_agent_limits_settings().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<IdleShutdownState>();
        let mut mode = state
            .mode
            .lock()
            .map_err(|_| "Shutdown state is unavailable.")?;
        if !mode.matches(expected_generation) {
            return Ok(false);
        }
        let windows = state
            .pending_media_windows
            .lock()
            .map_err(|_| "Media activity is unavailable.")?;
        let chats = state
            .pending_chat_windows
            .lock()
            .map_err(|_| "Chat activity is unavailable.")?;
        if !windows.is_empty() || !chats.is_empty() {
            return Ok(false);
        }
        let stopped = app
            .state::<crate::sleep_inhibition::SystemSleepInhibitor>()
            .finish_if_idle(|| {
                crate::shell_state::with_unchanged_snapshot(&app, expected_revision, |snapshot| {
                    if has_pending_native_work(&app)?
                        || chat_work::has_pending_chat_work(
                            snapshot,
                            settings.automatic_retries,
                            settings.retry_attempts,
                        )?
                    {
                        return Ok(false);
                    }
                    force_shutdown()?;
                    Ok(true)
                })
            });
        match stopped {
            Ok(true) => {
                mode.set_enabled(false)?;
                publish_mode(&app, *mode);
                Ok(true)
            }
            Ok(false) => Ok(false),
            Err(error) => {
                mode.set_enabled(false)?;
                publish_mode(&app, *mode);
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| format!("Shutdown check failed: {error}"))?
}

#[cfg(all(target_os = "windows", not(test)))]
fn force_shutdown() -> Result<(), String> {
    let windows = std::env::var_os("SystemRoot")
        .ok_or("PC shutdown failed: the Windows directory is unavailable.")?;
    let mut command = tokio::process::Command::new(
        std::path::Path::new(&windows)
            .join("System32")
            .join("shutdown.exe"),
    );
    command
        .args(["/s", "/f", "/t", "0"])
        .creation_flags(0x08000000);
    tauri::async_runtime::block_on(command::run(command, std::time::Duration::from_secs(10)))
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn force_shutdown() -> Result<(), String> {
    Err("PC shutdown is only available on Windows.".to_string())
}

#[cfg(test)]
fn force_shutdown() -> Result<(), String> {
    Err("PC shutdown is disabled in tests.".to_string())
}

#[cfg(test)]
mod tests {
    use super::IdleShutdownState;

    #[test]
    fn closing_a_window_with_pending_work_disarms_shutdown() {
        for media in [true, false] {
            let state = IdleShutdownState::default();
            state.mode.lock().unwrap().set_enabled(true).unwrap();
            let pending = if media {
                &state.pending_media_windows
            } else {
                &state.pending_chat_windows
            };
            pending.lock().unwrap().insert("working".to_string());
            assert!(!state.clear_window("idle").unwrap());
            assert!(state.mode.lock().unwrap().enabled);
            assert!(state.clear_window("working").unwrap());
            assert!(!state.mode.lock().unwrap().enabled);
        }
    }
}
