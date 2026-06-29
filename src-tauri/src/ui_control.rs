use std::env;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use xcap::Monitor;

mod bridge;
mod capture;
mod input;
mod windows;

pub use bridge::try_run_ui_control_bridge_from_args;

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
