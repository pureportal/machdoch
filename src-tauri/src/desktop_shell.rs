use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

mod shortcut;
mod startup;
mod tray;
mod window;

pub(crate) use shortcut::{sync_quick_voice_shortcut, validate_quick_voice_shortcut};
pub(crate) use startup::{
    apply_startup_mode, current_process_has_administrator_rights,
    hide_console_window_for_background_ui_launch, relaunch_as_administrator_if_configured,
    resolve_launch_context, restart_as_administrator_if_needed,
};
pub(crate) use tray::create_tray;
pub(crate) use window::{handle_window_event, sync_assistant_bubble_window};

pub(crate) const AUTOSTART_LAUNCH_ARG: &str = "--autostart";
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
pub(crate) const ASSISTANT_BUBBLE_WINDOW_LABEL: &str = "assistant-bubble";
pub(crate) const ASSISTANT_POPUP_WINDOW_LABEL: &str = "assistant-popup";
pub(crate) const QUICK_VOICE_WINDOW_LABEL: &str = "quick-voice";
pub(crate) const TRAY_MENU_WINDOW_LABEL: &str = "tray-menu";
pub(crate) const QUICK_VOICE_START_EVENT: &str = "machdoch://quick-voice-start";
pub(crate) const ADMIN_RELAUNCH_ARG: &str = "--machdoch-admin-relaunch";

#[derive(Debug, Default)]
pub(crate) struct QuickVoiceShortcutState(pub(crate) Mutex<Option<String>>);

#[derive(Debug, Clone)]
pub(crate) struct DesktopLaunchId(pub(crate) String);

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct LaunchContext {
    pub(crate) launched_from_autostart: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorBoundsInput {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickVoiceStartPayload {
    source_window_label: Option<String>,
}

pub(crate) fn create_desktop_launch_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    format!("{}-{timestamp}", std::process::id())
}

#[tauri::command]
pub fn get_desktop_launch_id(state: tauri::State<'_, DesktopLaunchId>) -> String {
    state.0.clone()
}

#[tauri::command]
pub fn detect_fullscreen_window_on_monitor(monitor: MonitorBoundsInput) -> Result<bool, String> {
    window::detect_fullscreen_window_on_monitor(monitor)
}

#[tauri::command]
pub fn reveal_main_window(app: AppHandle) {
    window::show_main_window(&app);
}

#[tauri::command]
pub fn hide_main_window_to_tray(app: AppHandle) {
    window::hide_to_tray(&app);
}

#[tauri::command]
pub fn quit_machdoch(app: AppHandle) {
    app.exit(0);
}
