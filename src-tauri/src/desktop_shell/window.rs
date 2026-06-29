use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};
use xcap::Window as DesktopWindow;

use crate::runtime_snapshot;

use super::{
    MonitorBoundsInput, QuickVoiceStartPayload, ASSISTANT_BUBBLE_WINDOW_LABEL,
    ASSISTANT_POPUP_WINDOW_LABEL, MAIN_WINDOW_LABEL, QUICK_VOICE_START_EVENT,
    QUICK_VOICE_WINDOW_LABEL, TRAY_MENU_WINDOW_LABEL,
};

const FULLSCREEN_TOLERANCE_PX: i32 = 12;
const FULLSCREEN_MIN_AREA_RATIO: f64 = 0.96;

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

pub(crate) fn sync_assistant_bubble_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let settings = runtime_snapshot::load_user_desktop_settings(app)?;
    let Some(window) = app.get_webview_window(ASSISTANT_BUBBLE_WINDOW_LABEL) else {
        return Ok(());
    };

    if settings.assistant_bubble_enabled {
        let _ = window.set_focusable(false);
        let _ = window.set_skip_taskbar(true);
        let _ = window.unminimize();
    } else {
        let _ = window.hide();

        if let Some(popup_window) = app.get_webview_window(ASSISTANT_POPUP_WINDOW_LABEL) {
            let _ = popup_window.hide();
        }
    }

    Ok(())
}

pub(super) fn detect_fullscreen_window_on_monitor(
    monitor: MonitorBoundsInput,
) -> Result<bool, String> {
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

pub(super) fn hide_transient_assistant_windows<R: Runtime, M: Manager<R>>(app: &M) {
    for label in [
        ASSISTANT_POPUP_WINDOW_LABEL,
        QUICK_VOICE_WINDOW_LABEL,
        TRAY_MENU_WINDOW_LABEL,
    ] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
}

pub(super) fn hide_to_tray<R: Runtime>(app: &AppHandle<R>) {
    hide_transient_assistant_windows(app);

    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let _ = window.set_skip_taskbar(true);
    let _ = window.hide();
}

pub(super) fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
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
