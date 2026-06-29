use std::time::Duration;

use enigo::{
    Button, Coordinate,
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Mouse, Settings,
};
use serde_json::Value;

use super::{
    serialize_data, ClickPointPayload, DragPointerPayload, PressKeysPayload, TypeTextPayload,
};

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

pub(super) fn click_point_action(payload: ClickPointPayload) -> Result<Value, String> {
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

pub(super) fn drag_pointer_action(payload: DragPointerPayload) -> Result<Value, String> {
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

pub(super) fn type_text_action(payload: TypeTextPayload) -> Result<Value, String> {
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

pub(super) fn press_keys_action(payload: PressKeysPayload) -> Result<Value, String> {
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
