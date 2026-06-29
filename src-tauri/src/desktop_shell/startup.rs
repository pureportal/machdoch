use std::env;

#[cfg(target_os = "windows")]
use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

use tauri::{AppHandle, Manager, Runtime};

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

use crate::runtime_snapshot;

use super::{window, LaunchContext, ADMIN_RELAUNCH_ARG, AUTOSTART_LAUNCH_ARG, MAIN_WINDOW_LABEL};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupWindowMode {
    OpenWindow,
    StartMinimized,
    StartInTray,
}

pub(crate) fn resolve_launch_context() -> LaunchContext {
    LaunchContext {
        launched_from_autostart: env::args().skip(1).any(|arg| arg == AUTOSTART_LAUNCH_ARG),
    }
}

fn should_hide_console_window_for_launch_args<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|argument| matches!(argument.as_ref(), AUTOSTART_LAUNCH_ARG | ADMIN_RELAUNCH_ARG))
}

pub(crate) fn hide_console_window_for_background_ui_launch() {
    #[cfg(target_os = "windows")]
    {
        if !should_hide_console_window_for_launch_args(env::args().skip(1)) {
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
    window::hide_transient_assistant_windows(app);

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

    #[test]
    fn console_hiding_is_limited_to_background_ui_launches() {
        assert!(should_hide_console_window_for_launch_args([
            AUTOSTART_LAUNCH_ARG
        ]));
        assert!(should_hide_console_window_for_launch_args([
            "--ui",
            ADMIN_RELAUNCH_ARG
        ]));
        assert!(!should_hide_console_window_for_launch_args(["--ui"]));
        assert!(!should_hide_console_window_for_launch_args(["--cli"]));
    }
}
