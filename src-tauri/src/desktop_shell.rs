use std::{
    env,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, Window, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut as GlobalShortcut, ShortcutState};
#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, ERROR_CANCELLED, HANDLE},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::{
            Console::{FreeConsole, GetConsoleWindow},
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
        UI::{
            Shell::ShellExecuteW,
            WindowsAndMessaging::{ShowWindow, SW_HIDE},
        },
    },
};
use xcap::Window as DesktopWindow;

use crate::runtime_snapshot;

pub(crate) const AUTOSTART_LAUNCH_ARG: &str = "--autostart";
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
pub(crate) const ASSISTANT_BUBBLE_WINDOW_LABEL: &str = "assistant-bubble";
pub(crate) const ASSISTANT_POPUP_WINDOW_LABEL: &str = "assistant-popup";
pub(crate) const QUICK_VOICE_WINDOW_LABEL: &str = "quick-voice";
pub(crate) const QUICK_VOICE_START_EVENT: &str = "machdoch://quick-voice-start";
pub(crate) const DEFAULT_QUICK_VOICE_SHORTCUT: &str = "CommandOrControl+Alt+V";
pub(crate) const ADMIN_RELAUNCH_ARG: &str = "--machdoch-admin-relaunch";

const TRAY_ID: &str = "machdoch-tray";
const TRAY_MENU_SHOW_ID: &str = "tray-show";
const TRAY_MENU_HIDE_ID: &str = "tray-hide";
const TRAY_MENU_QUIT_ID: &str = "tray-quit";
const FULLSCREEN_TOLERANCE_PX: i32 = 12;
const FULLSCREEN_MIN_AREA_RATIO: f64 = 0.96;
const QUICK_VOICE_SHORTCUT_SOURCE: &str = "global-shortcut";

#[derive(Debug, Default)]
pub(crate) struct QuickVoiceShortcutState(pub(crate) Mutex<Option<String>>);

#[derive(Debug, Clone)]
pub(crate) struct DesktopLaunchId(pub(crate) String);

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct LaunchContext {
    pub(crate) launched_from_autostart: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupWindowMode {
    OpenWindow,
    StartMinimized,
    StartInTray,
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

pub(crate) fn resolve_launch_context() -> LaunchContext {
    LaunchContext {
        launched_from_autostart: env::args().skip(1).any(|arg| arg == AUTOSTART_LAUNCH_ARG),
    }
}

pub(crate) fn create_desktop_launch_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    format!("{}-{timestamp}", std::process::id())
}

pub(crate) fn hide_console_window_for_admin_relaunch() {
    #[cfg(target_os = "windows")]
    {
        if !env::args().skip(1).any(|arg| arg == ADMIN_RELAUNCH_ARG) {
            return;
        }

        unsafe {
            let console_window = GetConsoleWindow();

            if !console_window.is_invalid() {
                let _ = ShowWindow(console_window, SW_HIDE);
            }

            let _ = FreeConsole();
        }
    }
}

pub(crate) fn current_process_has_administrator_rights() -> bool {
    #[cfg(target_os = "windows")]
    {
        is_current_process_elevated().unwrap_or(false)
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

pub(crate) fn administrator_relaunch_supported() -> bool {
    #[cfg(not(target_os = "windows"))]
    {
        false
    }

    #[cfg(all(target_os = "windows", not(debug_assertions)))]
    {
        true
    }

    #[cfg(all(target_os = "windows", debug_assertions))]
    {
        env::var("MACHDOCH_ENABLE_ADMIN_RELAUNCH_IN_DEV")
            .map(|value| value == "true" || value == "1")
            .unwrap_or(false)
    }
}

pub(crate) fn relaunch_as_administrator_if_configured() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        if !administrator_relaunch_supported() {
            return Ok(false);
        }

        if !runtime_snapshot::load_user_desktop_admin_preference()? {
            return Ok(false);
        }

        if is_current_process_elevated()? {
            return Ok(false);
        }

        return start_elevated_relaunch();
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

pub(crate) fn restart_as_administrator_if_needed<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if !administrator_relaunch_supported() {
            return Ok(());
        }

        if is_current_process_elevated()? {
            return Ok(());
        }

        if start_elevated_relaunch()? {
            app.exit(0);
        }

        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn is_current_process_elevated() -> Result<bool, String> {
    unsafe {
        let mut token = HANDLE::default();

        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|error| format!("Failed to inspect the current process token: {error}"))?;

        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned_length = 0u32;
        let token_info_result = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned_length,
        );

        let _ = CloseHandle(token);

        token_info_result
            .map_err(|error| format!("Failed to inspect process elevation: {error}"))?;

        Ok(elevation.TokenIsElevated != 0)
    }
}

#[cfg(target_os = "windows")]
fn start_elevated_relaunch() -> Result<bool, String> {
    let executable_path = env::current_exe()
        .map_err(|error| format!("Failed to resolve the current executable path: {error}"))?;
    let working_directory = env::current_dir().ok();
    let parameters = build_elevated_ui_relaunch_parameters();

    let operation = wide_null("runas");
    let executable = wide_os_null(executable_path.as_os_str());
    let parameters = wide_null(&parameters);
    let working_directory = working_directory
        .as_ref()
        .map(|path| wide_os_null(path.as_os_str()))
        .unwrap_or_else(|| vec![0]);

    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(executable.as_ptr()),
            PCWSTR(parameters.as_ptr()),
            PCWSTR(working_directory.as_ptr()),
            SW_HIDE,
        )
    };
    let result_code = result.0 as isize;

    if result_code > 32 {
        return Ok(true);
    }

    let result_code = result_code as u32;

    if result_code == ERROR_CANCELLED.0 {
        return Ok(false);
    }

    Err(format!(
        "Failed to restart machdoch as administrator. ShellExecute returned {result_code}."
    ))
}

#[cfg(target_os = "windows")]
fn build_elevated_ui_relaunch_parameters() -> String {
    std::iter::once("--ui".to_string())
        .chain(std::iter::once(ADMIN_RELAUNCH_ARG.to_string()))
        .chain(env::args_os().skip(1).filter_map(|argument| {
            let argument = argument.to_string_lossy();

            match argument.as_ref() {
                "--ui" | "--cli" | ADMIN_RELAUNCH_ARG => None,
                _ => Some(argument.into_owned()),
            }
        }))
        .map(|argument| quote_windows_argument(&argument))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn wide_os_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn quote_windows_argument(argument: &str) -> String {
    if argument.is_empty() {
        return "\"\"".to_string();
    }

    if !argument
        .chars()
        .any(|character| character.is_whitespace() || character == '"')
    {
        return argument.to_string();
    }

    let mut quoted = String::from("\"");
    let mut backslash_count = 0usize;

    for character in argument.chars() {
        match character {
            '\\' => {
                backslash_count += 1;
            }
            '"' => {
                quoted.push_str(&"\\".repeat(backslash_count * 2 + 1));
                quoted.push('"');
                backslash_count = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslash_count));
                backslash_count = 0;
                quoted.push(character);
            }
        }
    }

    quoted.push_str(&"\\".repeat(backslash_count * 2));
    quoted.push('"');
    quoted
}

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
                    let _ = show_quick_voice_window(app, Some(QUICK_VOICE_SHORTCUT_SOURCE));
                }
            })
            .map_err(|error| {
                format!("Failed to register the Quick Voice shortcut `{shortcut}`: {error}")
            })?;

        *registered_shortcut = Some(shortcut);
    }

    Ok(())
}

pub(crate) fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_MENU_SHOW_ID, "Show machdoch", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, TRAY_MENU_HIDE_ID, "Hide to tray", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &hide_item, &separator, &quit_item])?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("machdoch")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_MENU_SHOW_ID => {
                show_main_window(app);
            }
            TRAY_MENU_HIDE_ID => {
                hide_to_tray(app);
            }
            TRAY_MENU_QUIT_ID => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();

                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let is_hidden = !window.is_visible().unwrap_or(true);
                    let is_minimized = window.is_minimized().unwrap_or(false);

                    if is_hidden || is_minimized {
                        show_main_window(app);
                    } else {
                        let _ = window.set_focus();
                    }
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    let _ = tray.build(app)?;
    Ok(())
}

fn resolve_startup_window_mode(
    preferences: runtime_snapshot::UserDesktopLaunchPreferences,
) -> StartupWindowMode {
    if preferences.autostart_to_tray {
        return StartupWindowMode::StartInTray;
    }

    if preferences.autostart_minimized {
        return StartupWindowMode::StartMinimized;
    }

    StartupWindowMode::OpenWindow
}

pub(crate) fn apply_startup_mode<R: Runtime>(app: &AppHandle<R>, launch_context: LaunchContext) {
    hide_transient_assistant_windows(app);

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let preferences = runtime_snapshot::load_user_desktop_launch_preferences().unwrap_or_default();

    match resolve_startup_window_mode(preferences) {
        StartupWindowMode::StartInTray => {
            let _ = window.set_skip_taskbar(true);
            let _ = window.hide();
        }
        StartupWindowMode::StartMinimized => {
            let _ = window.set_skip_taskbar(false);
            let _ = window.show();
            let _ = window.minimize();
        }
        StartupWindowMode::OpenWindow => {
            let _ = window.set_skip_taskbar(false);
            let _ = window.show();

            if !launch_context.launched_from_autostart {
                let _ = window.set_focus();
            }
        }
    }
}

pub(crate) fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    api.prevent_close();
    hide_transient_assistant_windows(window);
    let _ = window.set_skip_taskbar(true);
    let _ = window.hide();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch_preferences(
        autostart_minimized: bool,
        autostart_to_tray: bool,
    ) -> runtime_snapshot::UserDesktopLaunchPreferences {
        runtime_snapshot::UserDesktopLaunchPreferences {
            autostart_minimized,
            autostart_to_tray,
        }
    }

    #[test]
    fn startup_mode_prefers_tray_over_minimized() {
        assert_eq!(
            resolve_startup_window_mode(launch_preferences(true, true)),
            StartupWindowMode::StartInTray
        );
    }

    #[test]
    fn startup_mode_uses_minimized_when_tray_is_disabled() {
        assert_eq!(
            resolve_startup_window_mode(launch_preferences(true, false)),
            StartupWindowMode::StartMinimized
        );
    }

    #[test]
    fn startup_mode_opens_window_by_default() {
        assert_eq!(
            resolve_startup_window_mode(launch_preferences(false, false)),
            StartupWindowMode::OpenWindow
        );
    }
}

pub(crate) fn sync_assistant_bubble_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let settings = runtime_snapshot::load_user_desktop_settings(app)?;
    let Some(window) = app.get_webview_window(ASSISTANT_BUBBLE_WINDOW_LABEL) else {
        return Ok(());
    };

    if settings.assistant_bubble_enabled {
        let _ = window.set_skip_taskbar(true);
        let _ = window.unminimize();
        window
            .show()
            .map_err(|error| format!("Failed to show the assistant bubble window: {error}"))?;
    } else {
        let _ = window.hide();

        if let Some(popup_window) = app.get_webview_window(ASSISTANT_POPUP_WINDOW_LABEL) {
            let _ = popup_window.hide();
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_desktop_launch_id(state: tauri::State<'_, DesktopLaunchId>) -> String {
    state.0.clone()
}

#[tauri::command]
pub fn detect_fullscreen_window_on_monitor(monitor: MonitorBoundsInput) -> Result<bool, String> {
    let current_process_id = std::process::id();
    let windows = DesktopWindow::all().map_err(|error| {
        format!("Failed to enumerate desktop windows for fullscreen detection: {error}")
    })?;

    for window in windows {
        if window.pid().unwrap_or_default() == current_process_id {
            continue;
        }

        if window.is_minimized().unwrap_or(false) {
            continue;
        }

        if !window.is_focused().unwrap_or(false) {
            continue;
        }

        if !window_matches_monitor(&window, &monitor) {
            continue;
        }

        if window
            .title()
            .map(|title| title.trim().is_empty())
            .unwrap_or(true)
            && window
                .app_name()
                .map(|name| name.trim().is_empty())
                .unwrap_or(true)
        {
            continue;
        }

        if is_effectively_fullscreen(&window, &monitor) {
            return Ok(true);
        }
    }

    Ok(false)
}

pub(crate) fn show_quick_voice_window<R: Runtime>(
    app: &AppHandle<R>,
    source_window_label: Option<&str>,
) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(QUICK_VOICE_WINDOW_LABEL) else {
        return Ok(());
    };

    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    let _ = app.emit_to(
        QUICK_VOICE_WINDOW_LABEL,
        QUICK_VOICE_START_EVENT,
        QuickVoiceStartPayload {
            source_window_label: source_window_label.map(str::to_string),
        },
    );

    Ok(())
}

#[tauri::command]
pub fn reveal_main_window(app: AppHandle) {
    show_main_window(&app);
}

fn hide_transient_assistant_windows<R: Runtime, M: Manager<R>>(app: &M) {
    for label in [ASSISTANT_POPUP_WINDOW_LABEL, QUICK_VOICE_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
}

fn hide_to_tray<R: Runtime>(app: &AppHandle<R>) {
    hide_transient_assistant_windows(app);

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let _ = window.set_skip_taskbar(true);
    let _ = window.hide();
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    hide_transient_assistant_windows(app);

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let _ = window.set_skip_taskbar(false);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn window_matches_monitor(window: &DesktopWindow, monitor: &MonitorBoundsInput) -> bool {
    let Ok(current_monitor) = window.current_monitor() else {
        return false;
    };
    let Ok(monitor_x) = current_monitor.x() else {
        return false;
    };
    let Ok(monitor_y) = current_monitor.y() else {
        return false;
    };
    let Ok(monitor_width) = current_monitor.width() else {
        return false;
    };
    let Ok(monitor_height) = current_monitor.height() else {
        return false;
    };

    monitor_x.abs_diff(monitor.x) <= FULLSCREEN_TOLERANCE_PX as u32
        && monitor_y.abs_diff(monitor.y) <= FULLSCREEN_TOLERANCE_PX as u32
        && monitor_width.abs_diff(monitor.width) <= FULLSCREEN_TOLERANCE_PX as u32
        && monitor_height.abs_diff(monitor.height) <= FULLSCREEN_TOLERANCE_PX as u32
}

fn is_effectively_fullscreen(window: &DesktopWindow, monitor: &MonitorBoundsInput) -> bool {
    let Ok(window_x) = window.x() else {
        return false;
    };
    let Ok(window_y) = window.y() else {
        return false;
    };
    let Ok(window_width) = window.width() else {
        return false;
    };
    let Ok(window_height) = window.height() else {
        return false;
    };

    let window_left = i64::from(window_x);
    let window_top = i64::from(window_y);
    let window_right = window_left + i64::from(window_width);
    let window_bottom = window_top + i64::from(window_height);
    let monitor_left = i64::from(monitor.x);
    let monitor_top = i64::from(monitor.y);
    let monitor_right = monitor_left + i64::from(monitor.width);
    let monitor_bottom = monitor_top + i64::from(monitor.height);
    let overlap_width = (window_right.min(monitor_right) - window_left.max(monitor_left)).max(0);
    let overlap_height = (window_bottom.min(monitor_bottom) - window_top.max(monitor_top)).max(0);
    let overlap_area = overlap_width * overlap_height;
    let monitor_area = i64::from(monitor.width) * i64::from(monitor.height);

    if monitor_area <= 0 {
        return false;
    }

    let horizontal_cover = window_left <= monitor_left + i64::from(FULLSCREEN_TOLERANCE_PX)
        && window_right >= monitor_right - i64::from(FULLSCREEN_TOLERANCE_PX);
    let vertical_cover = window_top <= monitor_top + i64::from(FULLSCREEN_TOLERANCE_PX)
        && window_bottom >= monitor_bottom - i64::from(FULLSCREEN_TOLERANCE_PX);
    let area_ratio = overlap_area as f64 / monitor_area as f64;

    horizontal_cover && vertical_cover && area_ratio >= FULLSCREEN_MIN_AREA_RATIO
}
