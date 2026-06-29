use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::{imageops::FilterType, DynamicImage, ImageFormat, RgbaImage};
use serde_json::Value;
use xcap::{Monitor, Window};

use super::{
    serialize_data, CaptureScreenPayload, CaptureWindowPayload, UiCaptureRegion, UiImagePayload,
    UiMonitorCapture, UiMonitorInfo, UiWindowCapture, UiWindowInfo, DEFAULT_CAPTURE_MAX_HEIGHT,
    DEFAULT_CAPTURE_MAX_WIDTH,
};

fn normalize_capture_region(
    payload: &CaptureScreenPayload,
) -> Result<Option<UiCaptureRegion>, String> {
    match (payload.x, payload.y, payload.width, payload.height) {
        (None, None, None, None) => Ok(None),
        (Some(x), Some(y), Some(width), Some(height)) => Ok(Some(UiCaptureRegion {
            x,
            y,
            width,
            height,
        })),
        _ => Err(
            "Expected x, y, width, and height together when capturing a screen region.".to_string(),
        ),
    }
}

fn get_capture_limits(max_width: Option<u32>, max_height: Option<u32>) -> (u32, u32) {
    (
        max_width.unwrap_or(DEFAULT_CAPTURE_MAX_WIDTH).max(1),
        max_height.unwrap_or(DEFAULT_CAPTURE_MAX_HEIGHT).max(1),
    )
}

fn encode_image_payload(
    image: RgbaImage,
    max_width: u32,
    max_height: u32,
) -> Result<UiImagePayload, String> {
    let original_width = image.width();
    let original_height = image.height();
    let scale = f32::min(
        f32::min(
            max_width as f32 / original_width as f32,
            max_height as f32 / original_height as f32,
        ),
        1.0,
    );
    let output_image = if scale < 1.0 {
        let width = ((original_width as f32) * scale).round().max(1.0) as u32;
        let height = ((original_height as f32) * scale).round().max(1.0) as u32;
        image::imageops::resize(&image, width, height, FilterType::Triangle)
    } else {
        image
    };
    let width = output_image.width();
    let height = output_image.height();
    let mut cursor = Cursor::new(Vec::new());

    DynamicImage::ImageRgba8(output_image)
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|error| format!("Failed to encode UI capture as PNG: {error}"))?;

    Ok(UiImagePayload {
        media_type: "image/png".to_string(),
        data: BASE64_STANDARD.encode(cursor.into_inner()),
        width,
        height,
        original_width,
        original_height,
    })
}

fn monitor_to_info(monitor: &Monitor) -> Result<UiMonitorInfo, String> {
    Ok(UiMonitorInfo {
        id: monitor.id().map_err(|error| error.to_string())?,
        name: monitor.name().unwrap_or_else(|_| "unknown".to_string()),
        friendly_name: monitor
            .friendly_name()
            .unwrap_or_else(|_| "Unknown monitor".to_string()),
        x: monitor.x().map_err(|error| error.to_string())?,
        y: monitor.y().map_err(|error| error.to_string())?,
        width: monitor.width().map_err(|error| error.to_string())?,
        height: monitor.height().map_err(|error| error.to_string())?,
        scale_factor: monitor.scale_factor().unwrap_or(1.0),
        is_primary: monitor.is_primary().unwrap_or(false),
    })
}

#[cfg(target_os = "windows")]
fn window_native_handle(window: &Window) -> Option<String> {
    Some(format!("0x{:x}", window.id().ok()? as usize))
}

#[cfg(not(target_os = "windows"))]
fn window_native_handle(_window: &Window) -> Option<String> {
    None
}

pub(super) fn window_to_info(window: &Window) -> Result<UiWindowInfo, String> {
    let monitor = window.current_monitor().ok();

    Ok(UiWindowInfo {
        id: window.id().map_err(|error| error.to_string())?,
        pid: window.pid().unwrap_or(0),
        app_name: window.app_name().unwrap_or_default(),
        title: window.title().unwrap_or_default(),
        x: window.x().unwrap_or(0),
        y: window.y().unwrap_or(0),
        z: window.z().unwrap_or(0),
        width: window.width().unwrap_or(0),
        height: window.height().unwrap_or(0),
        is_minimized: window.is_minimized().unwrap_or(false),
        is_maximized: window.is_maximized().unwrap_or(false),
        is_focused: window.is_focused().unwrap_or(false),
        monitor_id: monitor.as_ref().and_then(|entry| entry.id().ok()),
        monitor_name: monitor
            .as_ref()
            .and_then(|entry| entry.friendly_name().ok()),
        native_handle: window_native_handle(window),
    })
}

pub(super) fn list_monitors_action() -> Result<Value, String> {
    let monitors = Monitor::all().map_err(|error| error.to_string())?;
    let monitor_infos = monitors
        .iter()
        .map(monitor_to_info)
        .collect::<Result<Vec<_>, _>>()?;

    serialize_data(&monitor_infos)
}

fn select_monitor(monitor_id: Option<u32>) -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|error| error.to_string())?;

    if let Some(monitor_id) = monitor_id {
        return monitors
            .into_iter()
            .find(|monitor| monitor.id().ok() == Some(monitor_id))
            .ok_or_else(|| format!("Monitor #{monitor_id} was not found."));
    }

    let primary_index = monitors
        .iter()
        .position(|monitor| monitor.is_primary().unwrap_or(false))
        .unwrap_or(0);

    monitors
        .into_iter()
        .nth(primary_index)
        .ok_or_else(|| "No monitor was available for capture.".to_string())
}

pub(super) fn find_window(window_id: u32) -> Result<Window, String> {
    Window::all()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|window| window.id().ok() == Some(window_id))
        .ok_or_else(|| format!("Window #{window_id} was not found."))
}

pub(super) fn capture_screen_action(payload: CaptureScreenPayload) -> Result<Value, String> {
    let monitor = select_monitor(payload.monitor_id)?;
    let monitor_info = monitor_to_info(&monitor)?;
    let region = normalize_capture_region(&payload)?;
    let image = if let Some(region) = region {
        monitor
            .capture_region(region.x, region.y, region.width, region.height)
            .map_err(|error| error.to_string())?
    } else {
        monitor.capture_image().map_err(|error| error.to_string())?
    };
    let (max_width, max_height) = get_capture_limits(payload.max_width, payload.max_height);
    let capture = UiMonitorCapture {
        image: encode_image_payload(image, max_width, max_height)?,
        monitor: monitor_info,
        region,
    };

    serialize_data(&capture)
}

pub(super) fn list_windows_action() -> Result<Value, String> {
    let windows = Window::all().map_err(|error| error.to_string())?;
    let window_infos = windows
        .iter()
        .map(window_to_info)
        .collect::<Result<Vec<_>, _>>()?;

    serialize_data(&window_infos)
}

pub(super) fn capture_window_action(payload: CaptureWindowPayload) -> Result<Value, String> {
    let window = find_window(payload.window_id)?;

    if window.is_minimized().unwrap_or(false) {
        return Err("The requested window is minimized and cannot be captured yet.".to_string());
    }

    let image = window.capture_image().map_err(|error| error.to_string())?;
    let window_info = window_to_info(&window)?;
    let (max_width, max_height) = get_capture_limits(payload.max_width, payload.max_height);
    let capture = UiWindowCapture {
        image: encode_image_payload(image, max_width, max_height)?,
        window: window_info,
    };

    serialize_data(&capture)
}
