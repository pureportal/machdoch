use std::{env, fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    capture::{
        capture_screen_action, capture_window_action, list_monitors_action, list_windows_action,
    },
    detect_ui_control_availability,
    input::{click_point_action, drag_pointer_action, press_keys_action, type_text_action},
};

#[cfg(target_os = "windows")]
use super::windows::{
    click_window_control_action, focus_window_action, list_window_controls_action,
    set_window_control_text_action,
};

#[cfg(not(target_os = "windows"))]
use super::windows::unsupported_windows_handle_action;

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
