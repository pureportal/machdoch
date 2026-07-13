use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::{ProgressBarState, ProgressBarStatus},
    AppHandle, Manager, Runtime,
};

use super::window;

const TRAY_ID: &str = "machdoch-tray";
const TRAY_DEFAULT_TOOLTIP: &str = "machdoch - local assistant";
const TRAY_COMPLETE_TOOLTIP: &str = "machdoch - chat session complete";
const TRAY_MENU_SHOW_ID: &str = "tray-show";
const TRAY_MENU_HIDE_ID: &str = "tray-hide";
const TRAY_MENU_QUIT_ID: &str = "tray-quit";

pub(crate) fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_MENU_SHOW_ID, "Open machdoch", true, None::<&str>)?;
    let hide_item = MenuItem::with_id(app, TRAY_MENU_HIDE_ID, "Hide to tray", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "Quit machdoch", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &hide_item, &separator, &quit_item])?;
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(default_tray_icon())
        .tooltip(TRAY_DEFAULT_TOOLTIP)
        .menu(&menu)
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
            _ => {}
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_MENU_SHOW_ID => {
                window::show_main_window(app);
            }
            TRAY_MENU_HIDE_ID => {
                window::hide_to_tray(app);
            }
            TRAY_MENU_QUIT_ID => {
                super::request_graceful_exit(app);
            }
            _ => {}
        });

    let _ = tray.build(app)?;
    Ok(())
}

pub(crate) fn sync_chat_completion_indicator<R: Runtime>(
    app: &AppHandle<R>,
    completed: bool,
) -> Result<(), String> {
    let mut errors = Vec::new();

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let icon = if completed {
            completed_tray_icon()
        } else {
            default_tray_icon()
        };

        if let Err(error) = tray.set_icon(Some(icon)) {
            errors.push(format!("tray icon update failed: {error}"));
        }

        if let Err(error) = tray.set_tooltip(Some(if completed {
            TRAY_COMPLETE_TOOLTIP
        } else {
            TRAY_DEFAULT_TOOLTIP
        })) {
            errors.push(format!("tray tooltip update failed: {error}"));
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Err(error) = tray.set_title(if completed { Some("OK") } else { None }) {
            errors.push(format!("tray title update failed: {error}"));
        }
    }

    if let Some(window) = app.get_webview_window(super::MAIN_WINDOW_LABEL) {
        if let Err(error) = sync_taskbar_completion_indicator(&window, completed) {
            errors.push(error);
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn sync_taskbar_completion_indicator<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    completed: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    window
        .set_overlay_icon(if completed {
            Some(completion_badge_icon())
        } else {
            None
        })
        .map_err(|error| format!("taskbar overlay update failed: {error}"))?;

    #[cfg(target_os = "macos")]
    window
        .set_badge_label(if completed {
            Some("OK".to_string())
        } else {
            None
        })
        .map_err(|error| format!("taskbar badge label update failed: {error}"))?;

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    window
        .set_badge_count(if completed { Some(1) } else { None })
        .map_err(|error| format!("taskbar badge count update failed: {error}"))?;

    window
        .set_progress_bar(ProgressBarState {
            status: Some(if completed {
                ProgressBarStatus::Normal
            } else {
                ProgressBarStatus::None
            }),
            progress: if completed { Some(100) } else { None },
        })
        .map_err(|error| format!("taskbar progress update failed: {error}"))?;

    Ok(())
}

fn default_tray_icon() -> Image<'static> {
    tauri::include_image!("./icons/32x32.png")
}

fn completed_tray_icon() -> Image<'static> {
    let base = default_tray_icon();
    let mut rgba = base.rgba().to_vec();
    let width = base.width();
    let height = base.height();

    draw_completion_badge(
        &mut rgba,
        width,
        height,
        width as f64 * 0.73,
        height as f64 * 0.73,
        width.min(height) as f64 * 0.31,
    );

    Image::new_owned(rgba, width, height)
}

fn completion_badge_icon() -> Image<'static> {
    let size = 32;
    let mut rgba = vec![0; size * size * 4];

    draw_completion_badge(&mut rgba, 32, 32, 15.5, 15.5, 13.5);

    Image::new_owned(rgba, 32, 32)
}

fn draw_completion_badge(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    center_x: f64,
    center_y: f64,
    radius: f64,
) {
    draw_circle(
        rgba,
        width,
        height,
        center_x,
        center_y,
        radius + 1.8,
        [240, 253, 244, 255],
    );
    draw_circle(
        rgba,
        width,
        height,
        center_x,
        center_y,
        radius,
        [22, 163, 74, 255],
    );

    let start = (center_x - radius * 0.46, center_y - radius * 0.02);
    let middle = (center_x - radius * 0.13, center_y + radius * 0.31);
    let end = (center_x + radius * 0.48, center_y - radius * 0.36);
    let thickness = (radius * 0.24).max(2.2);

    draw_line(
        rgba,
        width,
        height,
        start,
        middle,
        thickness,
        [255, 255, 255, 255],
    );
    draw_line(
        rgba,
        width,
        height,
        middle,
        end,
        thickness,
        [255, 255, 255, 255],
    );
}

fn draw_circle(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    center_x: f64,
    center_y: f64,
    radius: f64,
    color: [u8; 4],
) {
    for y in 0..height {
        for x in 0..width {
            let dx = x as f64 + 0.5 - center_x;
            let dy = y as f64 + 0.5 - center_y;
            let coverage = (radius + 0.5 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);

            if coverage > 0.0 {
                blend_pixel(rgba, width, x, y, color, coverage);
            }
        }
    }
}

fn draw_line(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    start: (f64, f64),
    end: (f64, f64),
    thickness: f64,
    color: [u8; 4],
) {
    let half_thickness = thickness / 2.0;
    let min_x = ((start.0.min(end.0) - half_thickness - 1.0).floor().max(0.0)) as u32;
    let max_x = ((start.0.max(end.0) + half_thickness + 1.0)
        .ceil()
        .min(width.saturating_sub(1) as f64)) as u32;
    let min_y = ((start.1.min(end.1) - half_thickness - 1.0).floor().max(0.0)) as u32;
    let max_y = ((start.1.max(end.1) + half_thickness + 1.0)
        .ceil()
        .min(height.saturating_sub(1) as f64)) as u32;
    let segment_x = end.0 - start.0;
    let segment_y = end.1 - start.1;
    let segment_length_squared = segment_x * segment_x + segment_y * segment_y;

    if segment_length_squared <= f64::EPSILON {
        return;
    }

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let pixel_x = x as f64 + 0.5;
            let pixel_y = y as f64 + 0.5;
            let projection = (((pixel_x - start.0) * segment_x + (pixel_y - start.1) * segment_y)
                / segment_length_squared)
                .clamp(0.0, 1.0);
            let closest_x = start.0 + projection * segment_x;
            let closest_y = start.1 + projection * segment_y;
            let dx = pixel_x - closest_x;
            let dy = pixel_y - closest_y;
            let coverage = (half_thickness + 0.5 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);

            if coverage > 0.0 {
                blend_pixel(rgba, width, x, y, color, coverage);
            }
        }
    }
}

fn blend_pixel(rgba: &mut [u8], width: u32, x: u32, y: u32, color: [u8; 4], coverage: f64) {
    let index = ((y * width + x) * 4) as usize;

    if index + 3 >= rgba.len() {
        return;
    }

    let source_alpha = (color[3] as f64 / 255.0) * coverage;
    let target_alpha = rgba[index + 3] as f64 / 255.0;
    let output_alpha = source_alpha + target_alpha * (1.0 - source_alpha);

    if output_alpha <= f64::EPSILON {
        return;
    }

    for channel in 0..3 {
        let source = color[channel] as f64 / 255.0;
        let target = rgba[index + channel] as f64 / 255.0;
        let output =
            (source * source_alpha + target * target_alpha * (1.0 - source_alpha)) / output_alpha;

        rgba[index + channel] = (output * 255.0).round().clamp(0.0, 255.0) as u8;
    }

    rgba[index + 3] = (output_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
}
