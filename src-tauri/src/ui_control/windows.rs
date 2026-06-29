use serde_json::Value;

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

#[cfg(target_os = "windows")]
use super::{
    capture::{find_window, window_to_info},
    input::click_point_action,
    serialize_data, ClickPointPayload, ControlHandlePayload, SetControlTextPayload,
    UiWindowControlInfo, WindowHandlePayload, WindowIdPayload,
};

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
    let controls = unsafe { &mut *(state.0 as *mut Vec<UiWindowControlInfo>) };

    if let Ok(info) = get_control_info(hwnd) {
        controls.push(info);
    }

    true.into()
}

#[cfg(target_os = "windows")]
pub(super) fn list_window_controls_action(payload: WindowHandlePayload) -> Result<Value, String> {
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
pub(super) fn focus_window_action(payload: WindowIdPayload) -> Result<Value, String> {
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
pub(super) fn click_window_control_action(payload: ControlHandlePayload) -> Result<Value, String> {
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
pub(super) fn set_window_control_text_action(
    payload: SetControlTextPayload,
) -> Result<Value, String> {
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
pub(super) fn unsupported_windows_handle_action() -> Result<Value, String> {
    Err("Native window-handle control is only available on Windows.".to_string())
}
