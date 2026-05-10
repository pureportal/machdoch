use std::{env, fs, io::Cursor, path::PathBuf, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use enigo::{
    Button, Coordinate,
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Mouse, Settings,
};
use image::{imageops::FilterType, DynamicImage, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use xcap::{Monitor, Window};

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::{HWND, LPARAM, RECT, WPARAM},
    UI::Input::KeyboardAndMouse::IsWindowEnabled,
    UI::WindowsAndMessaging::{
        EnumChildWindows, GetAncestor, GetClassNameW, GetParent, GetWindowRect,
        GetWindowTextLengthW, GetWindowTextW, IsIconic, IsWindowVisible, SendMessageW,
        SetForegroundWindow, ShowWindow, BM_CLICK, GA_ROOT, SW_RESTORE, WM_SETTEXT,
    },
};

const DEFAULT_CAPTURE_MAX_WIDTH: u32 = 1440;
const DEFAULT_CAPTURE_MAX_HEIGHT: u32 = 900;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiControlAvailability {
    pub available: bool,
    pub platform: String,
    pub supports_screenshots: bool,
    pub supports_window_enumeration: bool,
    pub supports_input: bool,
    pub supports_window_handles: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiControlRuntimeInfo {
    #[serde(flatten)]
    pub availability: UiControlAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge_command: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiMonitorInfo {
    id: u32,
    name: String,
    friendly_name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f32,
    is_primary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiWindowInfo {
    id: u32,
    pid: u32,
    app_name: String,
    title: String,
    x: i32,
    y: i32,
    z: i32,
    width: u32,
    height: u32,
    is_minimized: bool,
    is_maximized: bool,
    is_focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    monitor_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    monitor_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(target_os = "windows")]
struct UiWindowControlInfo {
    handle: String,
    parent_handle: String,
    class_name: String,
    text: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    is_visible: bool,
    is_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiImagePayload {
    media_type: String,
    data: String,
    width: u32,
    height: u32,
    original_width: u32,
    original_height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiMonitorCapture {
    image: UiImagePayload,
    monitor: UiMonitorInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    region: Option<UiCaptureRegion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiWindowCapture {
    image: UiImagePayload,
    window: UiWindowInfo,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiCaptureRegion {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UiControlBridgeRequest {
    action: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiControlBridgeResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureScreenPayload {
    monitor_id: Option<u32>,
    x: Option<u32>,
    y: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
    max_width: Option<u32>,
    max_height: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureWindowPayload {
    window_id: u32,
    max_width: Option<u32>,
    max_height: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(target_os = "windows")]
struct WindowIdPayload {
    window_id: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickPointPayload {
    x: i32,
    y: i32,
    button: Option<String>,
    click_count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DragPointerPayload {
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    button: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeTextPayload {
    text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PressKeysPayload {
    keys: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(target_os = "windows")]
struct WindowHandlePayload {
    window_handle: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(target_os = "windows")]
struct ControlHandlePayload {
    control_handle: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(target_os = "windows")]
struct SetControlTextPayload {
    control_handle: String,
    text: String,
}

fn platform_name() -> String {
    if cfg!(target_os = "windows") {
        "windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else {
        "unknown".to_string()
    }
}

fn windows_handle_support() -> bool {
    cfg!(target_os = "windows")
}

pub fn detect_ui_control_availability() -> UiControlAvailability {
    #[cfg(target_os = "linux")]
    {
        let has_display = env::var("DISPLAY")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .is_some();
        let has_wayland = env::var("WAYLAND_DISPLAY")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .is_some();

        if !has_display && !has_wayland {
            return UiControlAvailability {
                available: false,
                platform: platform_name(),
                supports_screenshots: true,
                supports_window_enumeration: true,
                supports_input: true,
                supports_window_handles: false,
                reason: Some(
                    "No DISPLAY or WAYLAND_DISPLAY session was detected, so the environment looks headless."
                        .to_string(),
                ),
            };
        }
    }

    match Monitor::all() {
        Ok(monitors) if !monitors.is_empty() => UiControlAvailability {
            available: true,
            platform: platform_name(),
            supports_screenshots: true,
            supports_window_enumeration: true,
            supports_input: true,
            supports_window_handles: windows_handle_support(),
            reason: None,
        },
        Ok(_) => UiControlAvailability {
            available: false,
            platform: platform_name(),
            supports_screenshots: true,
            supports_window_enumeration: true,
            supports_input: true,
            supports_window_handles: windows_handle_support(),
            reason: Some("No active monitor was detected for desktop capture.".to_string()),
        },
        Err(error) => UiControlAvailability {
            available: false,
            platform: platform_name(),
            supports_screenshots: true,
            supports_window_enumeration: true,
            supports_input: true,
            supports_window_handles: windows_handle_support(),
            reason: Some(format!("Desktop capture is unavailable: {error}")),
        },
    }
}

pub fn create_ui_control_runtime_info() -> UiControlRuntimeInfo {
    UiControlRuntimeInfo {
        availability: detect_ui_control_availability(),
        bridge_command: resolve_bridge_command().ok(),
    }
}

fn resolve_bridge_command() -> Result<String, String> {
    env::current_exe()
        .map_err(|error| format!("Unable to resolve the desktop bridge executable: {error}"))
        .map(|path| path.display().to_string())
}

fn serialize_data<T: Serialize>(data: &T) -> Result<Value, String> {
    serde_json::to_value(data).map_err(|error| format!("Failed to serialize bridge data: {error}"))
}

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

fn create_enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default())
        .map_err(|error| format!("Failed to initialize desktop input automation: {error}"))
}

fn parse_button(button: Option<&str>) -> Result<Button, String> {
    match button
        .unwrap_or("left")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        "middle" => Ok(Button::Middle),
        other => Err(format!(
            "Unsupported mouse button `{other}`. Expected left, right, or middle."
        )),
    }
}

fn parse_key(name: &str) -> Result<Key, String> {
    let normalized = name.trim().to_ascii_lowercase();

    if normalized.chars().count() == 1 {
        return Ok(Key::Unicode(normalized.chars().next().unwrap_or_default()));
    }

    match normalized.as_str() {
        "alt" | "option" => Ok(Key::Alt),
        "backspace" => Ok(Key::Backspace),
        "capslock" => Ok(Key::CapsLock),
        "command" | "cmd" | "meta" | "super" | "windows" | "win" => Ok(Key::Meta),
        "control" | "ctrl" => Ok(Key::Control),
        "delete" | "del" => Ok(Key::Delete),
        "down" | "downarrow" => Ok(Key::DownArrow),
        "end" => Ok(Key::End),
        "enter" | "return" => Ok(Key::Return),
        "escape" | "esc" => Ok(Key::Escape),
        "home" => Ok(Key::Home),
        "insert" => Ok(Key::Insert),
        "left" | "leftarrow" => Ok(Key::LeftArrow),
        "pagedown" => Ok(Key::PageDown),
        "pageup" => Ok(Key::PageUp),
        "right" | "rightarrow" => Ok(Key::RightArrow),
        "shift" => Ok(Key::Shift),
        "space" => Ok(Key::Space),
        "tab" => Ok(Key::Tab),
        "up" | "uparrow" => Ok(Key::UpArrow),
        "f1" => Ok(Key::F1),
        "f2" => Ok(Key::F2),
        "f3" => Ok(Key::F3),
        "f4" => Ok(Key::F4),
        "f5" => Ok(Key::F5),
        "f6" => Ok(Key::F6),
        "f7" => Ok(Key::F7),
        "f8" => Ok(Key::F8),
        "f9" => Ok(Key::F9),
        "f10" => Ok(Key::F10),
        "f11" => Ok(Key::F11),
        "f12" => Ok(Key::F12),
        other => Err(format!("Unsupported key `{other}`.")),
    }
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

fn window_to_info(window: &Window) -> Result<UiWindowInfo, String> {
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

fn list_monitors_action() -> Result<Value, String> {
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

fn find_window(window_id: u32) -> Result<Window, String> {
    Window::all()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|window| window.id().ok() == Some(window_id))
        .ok_or_else(|| format!("Window #{window_id} was not found."))
}

fn capture_screen_action(payload: CaptureScreenPayload) -> Result<Value, String> {
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

fn list_windows_action() -> Result<Value, String> {
    let windows = Window::all().map_err(|error| error.to_string())?;
    let window_infos = windows
        .iter()
        .map(window_to_info)
        .collect::<Result<Vec<_>, _>>()?;

    serialize_data(&window_infos)
}

fn capture_window_action(payload: CaptureWindowPayload) -> Result<Value, String> {
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

fn click_point_action(payload: ClickPointPayload) -> Result<Value, String> {
    let mut enigo = create_enigo()?;
    let button = parse_button(payload.button.as_deref())?;

    enigo
        .move_mouse(payload.x, payload.y, Coordinate::Abs)
        .map_err(|error| error.to_string())?;

    for _ in 0..payload.click_count.unwrap_or(1).max(1) {
        enigo
            .button(button, Click)
            .map_err(|error| error.to_string())?;
    }

    serialize_data(&serde_json::json!({
        "x": payload.x,
        "y": payload.y,
        "button": payload.button.unwrap_or_else(|| "left".to_string()),
        "clickCount": payload.click_count.unwrap_or(1).max(1),
    }))
}

fn drag_pointer_action(payload: DragPointerPayload) -> Result<Value, String> {
    let mut enigo = create_enigo()?;
    let button = parse_button(payload.button.as_deref())?;

    enigo
        .move_mouse(payload.start_x, payload.start_y, Coordinate::Abs)
        .map_err(|error| error.to_string())?;
    enigo
        .button(button, Press)
        .map_err(|error| error.to_string())?;
    std::thread::sleep(Duration::from_millis(30));
    enigo
        .move_mouse(payload.end_x, payload.end_y, Coordinate::Abs)
        .map_err(|error| error.to_string())?;
    std::thread::sleep(Duration::from_millis(30));
    enigo
        .button(button, Release)
        .map_err(|error| error.to_string())?;

    serialize_data(&serde_json::json!({
        "startX": payload.start_x,
        "startY": payload.start_y,
        "endX": payload.end_x,
        "endY": payload.end_y,
        "button": payload.button.unwrap_or_else(|| "left".to_string()),
    }))
}

fn type_text_action(payload: TypeTextPayload) -> Result<Value, String> {
    if payload.text.is_empty() {
        return Err("Expected non-empty text for UI typing.".to_string());
    }

    let mut enigo = create_enigo()?;

    enigo
        .text(&payload.text)
        .map_err(|error| error.to_string())?;

    serialize_data(&serde_json::json!({
        "textLength": payload.text.chars().count(),
    }))
}

fn press_keys_action(payload: PressKeysPayload) -> Result<Value, String> {
    if payload.keys.is_empty() {
        return Err("Expected at least one key for UI key presses.".to_string());
    }

    let keys = payload
        .keys
        .iter()
        .map(|key| parse_key(key))
        .collect::<Result<Vec<_>, _>>()?;
    let mut enigo = create_enigo()?;

    for key in &keys {
        enigo.key(*key, Press).map_err(|error| error.to_string())?;
    }

    for key in keys.iter().rev() {
        enigo
            .key(*key, Release)
            .map_err(|error| error.to_string())?;
    }

    serialize_data(&serde_json::json!({
        "keys": payload.keys,
    }))
}

#[cfg(target_os = "windows")]
fn format_hwnd(hwnd: HWND) -> String {
    format!("0x{:x}", hwnd.0 as usize)
}

#[cfg(target_os = "windows")]
fn parse_hwnd(raw: &str) -> Result<HWND, String> {
    let trimmed = raw.trim();
    let parsed = if let Some(value) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        usize::from_str_radix(value, 16)
            .map_err(|error| format!("Invalid window handle `{trimmed}`: {error}"))?
    } else {
        trimmed
            .parse::<usize>()
            .map_err(|error| format!("Invalid window handle `{trimmed}`: {error}"))?
    };

    Ok(HWND(parsed as *mut _))
}

#[cfg(target_os = "windows")]
fn rect_size(rect: RECT) -> (i32, i32, u32, u32) {
    (
        rect.left,
        rect.top,
        (rect.right - rect.left).max(0) as u32,
        (rect.bottom - rect.top).max(0) as u32,
    )
}

#[cfg(target_os = "windows")]
fn get_window_text(hwnd: HWND) -> String {
    unsafe {
        let length = GetWindowTextLengthW(hwnd);
        let mut buffer = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buffer);

        String::from_utf16_lossy(&buffer[..copied as usize])
    }
}

#[cfg(target_os = "windows")]
fn get_class_name(hwnd: HWND) -> String {
    unsafe {
        let mut buffer = vec![0u16; 256];
        let copied = GetClassNameW(hwnd, &mut buffer);

        String::from_utf16_lossy(&buffer[..copied as usize])
    }
}

#[cfg(target_os = "windows")]
fn get_control_info(hwnd: HWND) -> Result<UiWindowControlInfo, String> {
    let mut rect = RECT::default();

    unsafe {
        GetWindowRect(hwnd, &mut rect).map_err(|error| error.to_string())?;
    }

    let (x, y, width, height) = rect_size(rect);
    let parent = unsafe { GetParent(hwnd) }.unwrap_or_default();

    Ok(UiWindowControlInfo {
        handle: format_hwnd(hwnd),
        parent_handle: format_hwnd(parent),
        class_name: get_class_name(hwnd),
        text: get_window_text(hwnd),
        x,
        y,
        width,
        height,
        is_visible: unsafe { IsWindowVisible(hwnd).as_bool() },
        is_enabled: unsafe { IsWindowEnabled(hwnd).as_bool() },
    })
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_child_windows(hwnd: HWND, state: LPARAM) -> windows::core::BOOL {
    let controls = &mut *(state.0 as *mut Vec<UiWindowControlInfo>);

    if let Ok(info) = get_control_info(hwnd) {
        controls.push(info);
    }

    true.into()
}

#[cfg(target_os = "windows")]
fn list_window_controls_action(payload: WindowHandlePayload) -> Result<Value, String> {
    let hwnd = parse_hwnd(&payload.window_handle)?;
    let mut controls = Vec::new();

    unsafe {
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(enum_child_windows),
            LPARAM((&mut controls as *mut Vec<UiWindowControlInfo>) as isize),
        );
    }

    serialize_data(&controls)
}

#[cfg(target_os = "windows")]
fn focus_window_action(payload: WindowIdPayload) -> Result<Value, String> {
    let hwnd = HWND(payload.window_id as usize as *mut _);

    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        let _ = SetForegroundWindow(hwnd);
    }

    let window = find_window(payload.window_id)?;
    let info = window_to_info(&window)?;

    serialize_data(&info)
}

#[cfg(target_os = "windows")]
fn focus_root_window(hwnd: HWND) {
    unsafe {
        let root = GetAncestor(hwnd, GA_ROOT);

        if !root.is_invalid() {
            if IsIconic(root).as_bool() {
                let _ = ShowWindow(root, SW_RESTORE);
            }

            let _ = SetForegroundWindow(root);
        }
    }
}

#[cfg(target_os = "windows")]
fn click_window_control_action(payload: ControlHandlePayload) -> Result<Value, String> {
    let hwnd = parse_hwnd(&payload.control_handle)?;

    focus_root_window(hwnd);

    let class_name = get_class_name(hwnd);

    if class_name.eq_ignore_ascii_case("Button") {
        unsafe {
            SendMessageW(hwnd, BM_CLICK, Some(WPARAM(0)), Some(LPARAM(0)));
        }
    } else {
        let control = get_control_info(hwnd)?;
        let center_x = control.x + (control.width / 2) as i32;
        let center_y = control.y + (control.height / 2) as i32;
        click_point_action(ClickPointPayload {
            x: center_x,
            y: center_y,
            button: Some("left".to_string()),
            click_count: Some(1),
        })?;
    }

    let control = get_control_info(hwnd)?;

    serialize_data(&control)
}

#[cfg(target_os = "windows")]
fn set_window_control_text_action(payload: SetControlTextPayload) -> Result<Value, String> {
    let hwnd = parse_hwnd(&payload.control_handle)?;
    focus_root_window(hwnd);

    let wide = payload
        .text
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();

    unsafe {
        SendMessageW(
            hwnd,
            WM_SETTEXT,
            Some(WPARAM(0)),
            Some(LPARAM(wide.as_ptr() as isize)),
        );
    }

    let control = get_control_info(hwnd)?;

    serialize_data(&control)
}

#[cfg(not(target_os = "windows"))]
fn unsupported_windows_handle_action() -> Result<Value, String> {
    Err("Native window-handle control is only available on Windows.".to_string())
}

fn execute_bridge_action(request: UiControlBridgeRequest) -> Result<Value, String> {
    let availability = detect_ui_control_availability();

    if !availability.available {
        return Err(availability.reason.unwrap_or_else(|| {
            "Desktop UI control is unavailable in the current environment.".to_string()
        }));
    }

    match request.action.as_str() {
        "list_monitors" => list_monitors_action(),
        "capture_screen" => capture_screen_action(
            serde_json::from_value(request.payload)
                .map_err(|error| format!("Invalid capture_screen payload: {error}"))?,
        ),
        "list_windows" => list_windows_action(),
        "capture_window" => capture_window_action(
            serde_json::from_value(request.payload)
                .map_err(|error| format!("Invalid capture_window payload: {error}"))?,
        ),
        "click_point" => click_point_action(
            serde_json::from_value(request.payload)
                .map_err(|error| format!("Invalid click_point payload: {error}"))?,
        ),
        "drag_pointer" => drag_pointer_action(
            serde_json::from_value(request.payload)
                .map_err(|error| format!("Invalid drag_pointer payload: {error}"))?,
        ),
        "type_text" => type_text_action(
            serde_json::from_value(request.payload)
                .map_err(|error| format!("Invalid type_text payload: {error}"))?,
        ),
        "press_keys" => press_keys_action(
            serde_json::from_value(request.payload)
                .map_err(|error| format!("Invalid press_keys payload: {error}"))?,
        ),
        "focus_window" => {
            #[cfg(target_os = "windows")]
            {
                focus_window_action(
                    serde_json::from_value(request.payload)
                        .map_err(|error| format!("Invalid focus_window payload: {error}"))?,
                )
            }

            #[cfg(not(target_os = "windows"))]
            {
                let _ = request;
                unsupported_windows_handle_action()
            }
        }
        "list_window_controls" => {
            #[cfg(target_os = "windows")]
            {
                list_window_controls_action(
                    serde_json::from_value(request.payload).map_err(|error| {
                        format!("Invalid list_window_controls payload: {error}")
                    })?,
                )
            }

            #[cfg(not(target_os = "windows"))]
            {
                let _ = request;
                unsupported_windows_handle_action()
            }
        }
        "click_window_control" => {
            #[cfg(target_os = "windows")]
            {
                click_window_control_action(
                    serde_json::from_value(request.payload).map_err(|error| {
                        format!("Invalid click_window_control payload: {error}")
                    })?,
                )
            }

            #[cfg(not(target_os = "windows"))]
            {
                let _ = request;
                unsupported_windows_handle_action()
            }
        }
        "set_window_control_text" => {
            #[cfg(target_os = "windows")]
            {
                set_window_control_text_action(
                    serde_json::from_value(request.payload).map_err(|error| {
                        format!("Invalid set_window_control_text payload: {error}")
                    })?,
                )
            }

            #[cfg(not(target_os = "windows"))]
            {
                let _ = request;
                unsupported_windows_handle_action()
            }
        }
        other => Err(format!("Unsupported desktop UI bridge action `{other}`.")),
    }
}

pub fn try_run_ui_control_bridge_from_args() -> Result<bool, String> {
    let mut args = env::args_os();
    let _ = args.next();
    let Some(flag) = args.next() else {
        return Ok(false);
    };

    if flag != "--ui-control-bridge-request-file" {
        return Ok(false);
    }

    let Some(path) = args.next() else {
        return Err(
            "Expected a JSON request file path after --ui-control-bridge-request-file.".to_string(),
        );
    };

    if args.next().is_some() {
        return Err("Unexpected extra arguments were passed to the desktop UI bridge.".to_string());
    }

    let request_path = PathBuf::from(path);
    let raw = fs::read_to_string(&request_path)
        .map_err(|error| format!("Failed to read {}: {error}", request_path.display()))?;
    let request = serde_json::from_str::<UiControlBridgeRequest>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", request_path.display()))?;
    let response = match execute_bridge_action(request) {
        Ok(data) => UiControlBridgeResponse {
            ok: true,
            data: Some(data),
            error: None,
        },
        Err(error) => UiControlBridgeResponse {
            ok: false,
            data: None,
            error: Some(error),
        },
    };

    println!(
        "{}",
        serde_json::to_string(&response)
            .map_err(|error| format!("Failed to serialize desktop UI bridge response: {error}"))?
    );

    Ok(true)
}
