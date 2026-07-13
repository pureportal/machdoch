use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut as GlobalShortcut, ShortcutState};

use crate::runtime_snapshot;

use super::{window, QuickVoiceShortcutState};

const QUICK_VOICE_SHORTCUT_SOURCE: &str = "global-shortcut";

pub(crate) fn validate_quick_voice_shortcut(shortcut: &str) -> Result<(), String> {
    let trimmed = shortcut.trim();

    if trimmed.is_empty() {
        return Err("Quick Voice shortcut cannot be empty.".to_string());
    }

    trimmed
        .parse::<GlobalShortcut>()
        .map(|_| ())
        .map_err(|error| format!("`{trimmed}` is not a valid global shortcut: {error}"))
}

pub(crate) fn sync_quick_voice_shortcut<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let settings = runtime_snapshot::load_user_desktop_settings(app)?;
    let desired_shortcut = if settings.quick_voice_enabled {
        Some(settings.quick_voice_shortcut.clone())
    } else {
        None
    };
    let state = app.state::<QuickVoiceShortcutState>();
    let mut registered_shortcut = state
        .0
        .lock()
        .map_err(|_| "The quick voice shortcut state is unavailable.".to_string())?;

    if registered_shortcut.as_deref() == desired_shortcut.as_deref() {
        return Ok(());
    }

    if let Some(previous_shortcut) = registered_shortcut.take() {
        app.global_shortcut()
            .unregister(previous_shortcut.as_str())
            .map_err(|error| {
                format!(
                    "Failed to unregister the previous Quick Voice shortcut `{previous_shortcut}`: {error}"
                )
            })?;
    }

    if let Some(shortcut) = desired_shortcut {
        app.global_shortcut()
            .on_shortcut(shortcut.as_str(), move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = window::show_quick_voice_window(
                            &app,
                            Some(QUICK_VOICE_SHORTCUT_SOURCE),
                        );
                    });
                }
            })
            .map_err(|error| {
                format!("Failed to register the Quick Voice shortcut `{shortcut}`: {error}")
            })?;

        *registered_shortcut = Some(shortcut);
    }

    Ok(())
}
