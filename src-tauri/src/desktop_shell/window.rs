use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};
#[cfg(not(target_os = "windows"))]
use xcap::Window as DesktopWindow;

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::RECT,
    UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, GetWindowTextLengthW, GetWindowThreadProcessId,
        IsIconic, IsWindowVisible,
    },
};

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

    if settings.assistant_bubble_enabled {
        let window = ensure_assistant_window(app, ASSISTANT_BUBBLE_WINDOW_LABEL)
            .map_err(|error| format!("Failed to create the assistant bubble: {error}"))?;
        let _ = window.set_focusable(false);
        let _ = window.set_skip_taskbar(true);
        let _ = window.unminimize();
    } else {
        if let Some(window) = app.get_webview_window(ASSISTANT_BUBBLE_WINDOW_LABEL) {
            let _ = window.destroy();
        }

        if let Some(popup_window) = app.get_webview_window(ASSISTANT_POPUP_WINDOW_LABEL) {
            let _ = popup_window.destroy();
        }
    }

    Ok(())
}

pub(crate) fn ensure_assistant_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }

    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .visible(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .decorations(false)
        .transparent(true)
        .shadow(false);

    match label {
        ASSISTANT_BUBBLE_WINDOW_LABEL => builder
            .title("machdoch Assistant Bubble")
            .inner_size(128.0, 104.0)
            .min_inner_size(128.0, 104.0)
            .focused(false)
            .focusable(false)
            .build()
            .map_err(|error| error.to_string()),
        ASSISTANT_POPUP_WINDOW_LABEL => builder
            .title("machdoch Assistant Popup")
            .inner_size(448.0, 720.0)
            .min_inner_size(448.0, 620.0)
            .build()
            .map_err(|error| error.to_string()),
        QUICK_VOICE_WINDOW_LABEL => builder
            .title("machdoch Quick Voice")
            .inner_size(380.0, 220.0)
            .min_inner_size(380.0, 220.0)
            .build()
            .map_err(|error| error.to_string()),
        _ => Err(format!("Unsupported assistant window label `{label}`.")),
    }
}

pub(super) fn ensure_tray_menu_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(TRAY_MENU_WINDOW_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        TRAY_MENU_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("machdoch")
    .inner_size(324.0, 252.0)
    .min_inner_size(324.0, 252.0)
    .visible(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .build()
    .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
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

#[cfg(target_os = "windows")]
pub(super) fn detect_fullscreen_window_on_monitor(
    monitor: MonitorBoundsInput,
) -> Result<bool, String> {
    unsafe {
        let window = GetForegroundWindow();

        if window.is_invalid()
            || !IsWindowVisible(window).as_bool()
            || IsIconic(window).as_bool()
            || GetWindowTextLengthW(window) <= 0
        {
            return Ok(false);
        }

        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process_id));

        if process_id == std::process::id() {
            return Ok(false);
        }

        let mut bounds = RECT::default();
        GetWindowRect(window, &mut bounds)
            .map_err(|error| format!("Failed to inspect the foreground window bounds: {error}"))?;

        Ok(is_rect_effectively_fullscreen(&bounds, &monitor))
    }
}

#[cfg(target_os = "windows")]
fn is_rect_effectively_fullscreen(bounds: &RECT, monitor: &MonitorBoundsInput) -> bool {
    let window_left = i64::from(bounds.left);
    let window_top = i64::from(bounds.top);
    let window_right = i64::from(bounds.right);
    let window_bottom = i64::from(bounds.bottom);
    let monitor_left = i64::from(monitor.x);
    let monitor_top = i64::from(monitor.y);
    let monitor_right = monitor_left + i64::from(monitor.width);
    let monitor_bottom = monitor_top + i64::from(monitor.height);
    let overlap_width = (window_right.min(monitor_right) - window_left.max(monitor_left)).max(0);
    let overlap_height = (window_bottom.min(monitor_bottom) - window_top.max(monitor_top)).max(0);
    let monitor_area = i64::from(monitor.width) * i64::from(monitor.height);

    if monitor_area <= 0 {
        return false;
    }

    let horizontal_cover = window_left <= monitor_left + i64::from(FULLSCREEN_TOLERANCE_PX)
        && window_right >= monitor_right - i64::from(FULLSCREEN_TOLERANCE_PX);
    let vertical_cover = window_top <= monitor_top + i64::from(FULLSCREEN_TOLERANCE_PX)
        && window_bottom >= monitor_bottom - i64::from(FULLSCREEN_TOLERANCE_PX);
    let overlap_area = overlap_width * overlap_height;
    let area_ratio = overlap_area as f64 / monitor_area as f64;

    horizontal_cover && vertical_cover && area_ratio >= FULLSCREEN_MIN_AREA_RATIO
}

pub(crate) fn show_quick_voice_window<R: Runtime>(
    app: &AppHandle<R>,
    source_window_label: Option<&str>,
) -> Result<(), String> {
    let window = ensure_assistant_window(app, QUICK_VOICE_WINDOW_LABEL)?;

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
    for label in [ASSISTANT_POPUP_WINDOW_LABEL, QUICK_VOICE_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
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

#[cfg(not(target_os = "windows"))]
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

#[cfg(not(target_os = "windows"))]
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
