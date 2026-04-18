use std::env;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

use crate::runtime_snapshot;

pub(crate) const AUTOSTART_LAUNCH_ARG: &str = "--autostart";

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "machdoch-tray";
const TRAY_MENU_SHOW_ID: &str = "tray-show";
const TRAY_MENU_HIDE_ID: &str = "tray-hide";
const TRAY_MENU_QUIT_ID: &str = "tray-quit";

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct LaunchContext {
    pub(crate) launched_from_autostart: bool,
}

pub(crate) fn resolve_launch_context() -> LaunchContext {
    LaunchContext {
        launched_from_autostart: env::args().skip(1).any(|arg| arg == AUTOSTART_LAUNCH_ARG),
    }
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

pub(crate) fn apply_startup_mode<R: Runtime>(app: &AppHandle<R>, launch_context: LaunchContext) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    if launch_context.launched_from_autostart {
        let preferences = runtime_snapshot::load_user_desktop_launch_preferences().unwrap_or_default();

        if preferences.autostart_to_tray {
            let _ = window.set_skip_taskbar(true);
            let _ = window.hide();
            return;
        }

        let _ = window.set_skip_taskbar(false);
        let _ = window.show();

        if preferences.autostart_minimized {
            let _ = window.minimize();
        }

        return;
    }

    let _ = window.set_skip_taskbar(false);
    let _ = window.show();
    let _ = window.set_focus();
}

fn hide_to_tray<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let _ = window.set_skip_taskbar(true);
    let _ = window.hide();
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let _ = window.set_skip_taskbar(false);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}