#[cfg(target_os = "linux")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, LogicalPosition, Manager, Runtime,
};

use super::{window, TRAY_MENU_WINDOW_LABEL};

const TRAY_ID: &str = "machdoch-tray";
const TRAY_MENU_WIDTH: f64 = 324.0;
const TRAY_MENU_HEIGHT: f64 = 252.0;
const TRAY_MENU_GAP: f64 = 10.0;
#[cfg(target_os = "linux")]
const TRAY_MENU_SHOW_ID: &str = "tray-show";
#[cfg(target_os = "linux")]
const TRAY_MENU_HIDE_ID: &str = "tray-hide";
#[cfg(target_os = "linux")]
const TRAY_MENU_QUIT_ID: &str = "tray-quit";

pub(crate) fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::include_image!("./icons/32x32.png"))
        .tooltip("machdoch - local assistant")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle();

                if let Some(window) = app.get_webview_window(super::MAIN_WINDOW_LABEL) {
                    let is_hidden = !window.is_visible().unwrap_or(true);
                    let is_minimized = window.is_minimized().unwrap_or(false);

                    if is_hidden || is_minimized {
                        window::show_main_window(app);
                    } else {
                        let _ = window.set_focus();
                    }
                }
            }
            TrayIconEvent::Click {
                position,
                rect,
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle();
                show_tray_menu_window(app, position.x, position.y, rect);
            }
            _ => {}
        });

    #[cfg(target_os = "linux")]
    let tray = {
        let show_item =
            MenuItem::with_id(app, TRAY_MENU_SHOW_ID, "Show machdoch", true, None::<&str>)?;
        let hide_item =
            MenuItem::with_id(app, TRAY_MENU_HIDE_ID, "Hide to tray", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "Quit", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&show_item, &hide_item, &separator, &quit_item])?;

        tray.menu(&menu)
            .on_menu_event(|app, event| match event.id.as_ref() {
                TRAY_MENU_SHOW_ID => {
                    window::show_main_window(app);
                }
                TRAY_MENU_HIDE_ID => {
                    window::hide_to_tray(app);
                }
                TRAY_MENU_QUIT_ID => {
                    app.exit(0);
                }
                _ => {}
            })
    };

    let _ = tray.build(app)?;
    Ok(())
}

fn show_tray_menu_window<R: Runtime>(
    app: &AppHandle<R>,
    click_x: f64,
    click_y: f64,
    tray_rect: tauri::Rect,
) {
    let Some(window) = app.get_webview_window(TRAY_MENU_WINDOW_LABEL) else {
        return;
    };

    let Some(position) = resolve_tray_menu_position(app, click_x, click_y, tray_rect) else {
        return;
    };

    let _ = window.set_skip_taskbar(true);
    let _ = window.set_position(LogicalPosition::new(position.x, position.y));
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct TrayMenuPosition {
    x: f64,
    y: f64,
}

fn resolve_tray_menu_position<R: Runtime>(
    app: &AppHandle<R>,
    click_x: f64,
    click_y: f64,
    tray_rect: tauri::Rect,
) -> Option<TrayMenuPosition> {
    let monitor = app
        .monitor_from_point(click_x, click_y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let work_area = monitor.work_area();
    let scale_factor = monitor.scale_factor();
    let menu_width = TRAY_MENU_WIDTH * scale_factor;
    let menu_height = TRAY_MENU_HEIGHT * scale_factor;
    let menu_gap = TRAY_MENU_GAP * scale_factor;
    let tray_position = tray_rect.position.to_physical::<f64>(scale_factor);
    let tray_size = tray_rect.size.to_physical::<f64>(scale_factor);

    let work_x = work_area.position.x as f64;
    let work_y = work_area.position.y as f64;
    let work_width = work_area.size.width as f64;
    let work_height = work_area.size.height as f64;
    let tray_center_x = if tray_size.width > 0.0 {
        tray_position.x + tray_size.width / 2.0
    } else {
        click_x
    };
    let tray_top = if tray_size.height > 0.0 {
        tray_position.y
    } else {
        click_y
    };
    let tray_bottom = if tray_size.height > 0.0 {
        tray_position.y + tray_size.height
    } else {
        click_y
    };
    let prefer_above = tray_top > work_y + (work_height / 2.0);
    let raw_x = tray_center_x - menu_width;
    let raw_y = if prefer_above {
        tray_top - menu_height - menu_gap
    } else {
        tray_bottom + menu_gap
    };
    let x = clamp_f64(
        raw_x,
        work_x + menu_gap,
        work_x + work_width - menu_width - menu_gap,
    );
    let y = clamp_f64(
        raw_y,
        work_y + menu_gap,
        work_y + work_height - menu_height - menu_gap,
    );

    Some(TrayMenuPosition {
        x: x / scale_factor,
        y: y / scale_factor,
    })
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    if min > max {
        return min;
    }

    value.min(max).max(min)
}
