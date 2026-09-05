#[cfg(target_os = "linux")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::{ProgressBarState, ProgressBarStatus},
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime,
};

use super::window;

const TRAY_ID: &str = "machdoch-tray";
const TRAY_DEFAULT_TOOLTIP: &str = "machdoch - local assistant";
const TRAY_COMPLETE_TOOLTIP: &str = "machdoch - chat session complete";
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
        .icon(default_tray_icon())
        .tooltip(TRAY_DEFAULT_TOOLTIP)
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
            MenuItem::with_id(app, TRAY_MENU_SHOW_ID, "Open machdoch", true, None::<&str>)?;
        let hide_item =
            MenuItem::with_id(app, TRAY_MENU_HIDE_ID, "Hide to tray", true, None::<&str>)?;
        let quit_item =
            MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "Quit machdoch", true, None::<&str>)?;
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
                    super::request_graceful_exit(app);
                }
                _ => {}
            })
    };

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

fn show_tray_menu_window<R: Runtime>(
    app: &AppHandle<R>,
    click_x: f64,
    click_y: f64,
    tray_rect: tauri::Rect,
) {
    let window = match window::ensure_tray_menu_window(app) {
        Ok(window) => window,
        Err(error) => {
            eprintln!("Failed to create the tray menu window: {error}");
            return;
        }
    };

    let Some(position) = resolve_tray_menu_position(app, click_x, click_y, tray_rect) else {
        return;
    };

    let _ = window.set_skip_taskbar(true);
    let _ = window.set_position(PhysicalPosition::new(
        position.x.round() as i32,
        position.y.round() as i32,
    ));
    let _ = window.set_size(PhysicalSize::new(
        position.width as u32,
        position.height as u32,
    ));
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct TrayMenuPosition {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
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
    let work = monitor.work_area();
    let (position, size) = if work.size.width > 0 && work.size.height > 0 {
        (work.position, work.size)
    } else {
        (*monitor.position(), *monitor.size())
    };
    compute_tray_menu_position(
        position,
        size,
        monitor.scale_factor(),
        (click_x, click_y),
        tray_rect,
    )
}

fn compute_tray_menu_position(
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    scale_factor: f64,
    (click_x, click_y): (f64, f64),
    tray_rect: tauri::Rect,
) -> Option<TrayMenuPosition> {
    if work_size.width == 0 || work_size.height == 0 {
        return None;
    }
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let menu_gap = (TRAY_MENU_GAP * scale_factor)
        .min((f64::from(work_size.width.min(work_size.height)) - 1.0).max(0.0) / 2.0)
        .floor();
    let menu_width = (TRAY_MENU_WIDTH * scale_factor)
        .round()
        .min((f64::from(work_size.width) - 2.0 * menu_gap).max(1.0));
    let menu_height = (TRAY_MENU_HEIGHT * scale_factor)
        .round()
        .min((f64::from(work_size.height) - 2.0 * menu_gap).max(1.0));
    let tray_position = tray_rect.position.to_physical::<f64>(scale_factor);
    let tray_size = tray_rect.size.to_physical::<f64>(scale_factor);

    let work_x = work_position.x as f64;
    let work_y = work_position.y as f64;
    let work_width = work_size.width as f64;
    let work_height = work_size.height as f64;
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
        x,
        y,
        width: menu_width,
        height: menu_height,
    })
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    if min > max {
        return min;
    }

    value.min(max).max(min)
}

#[cfg(test)]
mod display_tests {
    use super::*;
    fn tray(x: f64, y: f64) -> tauri::Rect {
        tauri::Rect {
            position: PhysicalPosition::new(x, y).into(),
            size: PhysicalSize::new(20.0, 20.0).into(),
        }
    }
    #[test]
    fn tray_menu_keeps_physical_coordinates_on_a_negative_high_dpi_display() {
        let layout = compute_tray_menu_position(
            PhysicalPosition::new(-2560, 0),
            PhysicalSize::new(2560, 1400),
            2.0,
            (-390.0, 1410.0),
            tray(-400.0, 1400.0),
        )
        .unwrap();
        assert_eq!(
            layout,
            TrayMenuPosition {
                x: -1038.0,
                y: 876.0,
                width: 648.0,
                height: 504.0
            }
        );
    }
    #[test]
    fn tray_menu_fits_compact_displays_and_top_taskbars() {
        let layout = compute_tray_menu_position(
            PhysicalPosition::new(0, 40),
            PhysicalSize::new(200, 100),
            1.5,
            (10.0, 10.0),
            tray(0.0, 0.0),
        )
        .unwrap();
        assert!(layout.x >= 0.0 && layout.y >= 40.0);
        assert!(layout.x + layout.width <= 200.0 && layout.y + layout.height <= 140.0);
        assert!(compute_tray_menu_position(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(0, 0),
            1.0,
            (0.0, 0.0),
            tray(0.0, 0.0)
        )
        .is_none());
    }
}
