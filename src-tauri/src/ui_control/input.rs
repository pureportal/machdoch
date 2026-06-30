use std::time::Duration;

use enigo::{
    Button, Coordinate, Direction,
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

trait InputAutomation {
    fn move_mouse(&mut self, x: i32, y: i32, coordinate: Coordinate) -> Result<(), String>;
    fn button(&mut self, button: Button, direction: Direction) -> Result<(), String>;
    fn text(&mut self, text: &str) -> Result<(), String>;
    fn key(&mut self, key: Key, direction: Direction) -> Result<(), String>;
}

impl InputAutomation for Enigo {
    fn move_mouse(&mut self, x: i32, y: i32, coordinate: Coordinate) -> Result<(), String> {
        Mouse::move_mouse(self, x, y, coordinate).map_err(|error| error.to_string())
    }

    fn button(&mut self, button: Button, direction: Direction) -> Result<(), String> {
        Mouse::button(self, button, direction).map_err(|error| error.to_string())
    }

    fn text(&mut self, text: &str) -> Result<(), String> {
        Keyboard::text(self, text).map_err(|error| error.to_string())
    }

    fn key(&mut self, key: Key, direction: Direction) -> Result<(), String> {
        Keyboard::key(self, key, direction).map_err(|error| error.to_string())
    }
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

fn with_cleanup_errors(primary_error: String, cleanup_errors: Vec<String>) -> String {
    if cleanup_errors.is_empty() {
        return primary_error;
    }

    format!(
        "{primary_error}; additionally failed to release pressed input: {}",
        cleanup_errors.join("; ")
    )
}

fn release_pressed_keys_reverse<T: InputAutomation>(
    automation: &mut T,
    pressed_keys: &mut Vec<Key>,
) -> Vec<String> {
    let mut cleanup_errors = Vec::new();

    while let Some(key) = pressed_keys.pop() {
        if let Err(error) = automation.key(key, Release) {
            cleanup_errors.push(error);
        }
    }

    cleanup_errors
}

pub(super) fn click_point_action(payload: ClickPointPayload) -> Result<Value, String> {
    let mut enigo = create_enigo()?;
    let button = parse_button(payload.button.as_deref())?;

    InputAutomation::move_mouse(&mut enigo, payload.x, payload.y, Coordinate::Abs)?;

    for _ in 0..payload.click_count.unwrap_or(1).max(1) {
        InputAutomation::button(&mut enigo, button, Click)?;
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

    drag_pointer_with(&mut enigo, &payload, button)?;

    serialize_data(&serde_json::json!({
        "startX": payload.start_x,
        "startY": payload.start_y,
        "endX": payload.end_x,
        "endY": payload.end_y,
        "button": payload.button.unwrap_or_else(|| "left".to_string()),
    }))
}

fn drag_pointer_with<T: InputAutomation>(
    automation: &mut T,
    payload: &DragPointerPayload,
    button: Button,
) -> Result<(), String> {
    automation.move_mouse(payload.start_x, payload.start_y, Coordinate::Abs)?;
    automation.button(button, Press)?;
    std::thread::sleep(Duration::from_millis(30));

    if let Err(error) = automation.move_mouse(payload.end_x, payload.end_y, Coordinate::Abs) {
        let cleanup_errors = automation
            .button(button, Release)
            .err()
            .into_iter()
            .collect();
        return Err(with_cleanup_errors(error, cleanup_errors));
    }

    std::thread::sleep(Duration::from_millis(30));
    automation.button(button, Release)
}

pub(super) fn type_text_action(payload: TypeTextPayload) -> Result<Value, String> {
    if payload.text.is_empty() {
        return Err("Expected non-empty text for UI typing.".to_string());
    }

    let mut enigo = create_enigo()?;

    InputAutomation::text(&mut enigo, &payload.text)?;

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

    press_keys_with(&mut enigo, &keys)?;

    serialize_data(&serde_json::json!({
        "keys": payload.keys,
    }))
}

fn press_keys_with<T: InputAutomation>(automation: &mut T, keys: &[Key]) -> Result<(), String> {
    let mut pressed_keys = Vec::new();

    for key in keys {
        if let Err(error) = automation.key(*key, Press) {
            let cleanup_errors = release_pressed_keys_reverse(automation, &mut pressed_keys);
            return Err(with_cleanup_errors(error, cleanup_errors));
        }

        pressed_keys.push(*key);
    }

    while let Some(key) = pressed_keys.pop() {
        if let Err(error) = automation.key(key, Release) {
            let cleanup_errors = release_pressed_keys_reverse(automation, &mut pressed_keys);
            return Err(with_cleanup_errors(error, cleanup_errors));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    #[derive(Default)]
    struct FakeAutomation {
        events: Vec<String>,
        failures: VecDeque<(String, String)>,
    }

    impl FakeAutomation {
        fn fail_on(mut self, event: String, error: &str) -> Self {
            self.failures.push_back((event, error.to_string()));
            self
        }

        fn record(&mut self, event: String) -> Result<(), String> {
            self.events.push(event.clone());

            if self
                .failures
                .front()
                .is_some_and(|(failed_event, _)| failed_event == &event)
            {
                return Err(self.failures.pop_front().unwrap().1);
            }

            Ok(())
        }
    }

    impl InputAutomation for FakeAutomation {
        fn move_mouse(&mut self, x: i32, y: i32, coordinate: Coordinate) -> Result<(), String> {
            self.record(move_mouse_event(x, y, coordinate))
        }

        fn button(&mut self, button: Button, direction: Direction) -> Result<(), String> {
            self.record(button_event(button, direction))
        }

        fn text(&mut self, text: &str) -> Result<(), String> {
            self.record(format!("text:{text}"))
        }

        fn key(&mut self, key: Key, direction: Direction) -> Result<(), String> {
            self.record(key_event(key, direction))
        }
    }

    fn move_mouse_event(x: i32, y: i32, coordinate: Coordinate) -> String {
        format!("move_mouse:{x}:{y}:{coordinate:?}")
    }

    fn button_event(button: Button, direction: Direction) -> String {
        format!("button:{button:?}:{direction:?}")
    }

    fn key_event(key: Key, direction: Direction) -> String {
        format!("key:{key:?}:{direction:?}")
    }

    #[test]
    fn drag_releases_pressed_button_when_end_move_fails() {
        let payload = DragPointerPayload {
            start_x: 10,
            start_y: 15,
            end_x: 30,
            end_y: 35,
            button: Some("left".to_string()),
        };
        let mut automation = FakeAutomation::default().fail_on(
            move_mouse_event(payload.end_x, payload.end_y, Coordinate::Abs),
            "move failed",
        );

        let result = drag_pointer_with(&mut automation, &payload, Button::Left);

        assert_eq!(result, Err("move failed".to_string()));
        assert_eq!(
            automation.events,
            vec![
                move_mouse_event(payload.start_x, payload.start_y, Coordinate::Abs),
                button_event(Button::Left, Press),
                move_mouse_event(payload.end_x, payload.end_y, Coordinate::Abs),
                button_event(Button::Left, Release),
            ]
        );
    }

    #[test]
    fn key_press_failure_releases_previously_pressed_keys_in_reverse_order() {
        let control = parse_key("control").unwrap();
        let shift = parse_key("shift").unwrap();
        let p = parse_key("p").unwrap();
        let keys = vec![control, shift, p];
        let mut automation =
            FakeAutomation::default().fail_on(key_event(p, Press), "p press failed");

        let result = press_keys_with(&mut automation, &keys);

        assert_eq!(result, Err("p press failed".to_string()));
        assert_eq!(
            automation.events,
            vec![
                key_event(control, Press),
                key_event(shift, Press),
                key_event(p, Press),
                key_event(shift, Release),
                key_event(control, Release),
            ]
        );
    }

    #[test]
    fn key_release_failure_still_releases_remaining_pressed_keys() {
        let control = parse_key("control").unwrap();
        let shift = parse_key("shift").unwrap();
        let p = parse_key("p").unwrap();
        let keys = vec![control, shift, p];
        let mut automation =
            FakeAutomation::default().fail_on(key_event(shift, Release), "shift release failed");

        let result = press_keys_with(&mut automation, &keys);

        assert_eq!(result, Err("shift release failed".to_string()));
        assert_eq!(
            automation.events,
            vec![
                key_event(control, Press),
                key_event(shift, Press),
                key_event(p, Press),
                key_event(p, Release),
                key_event(shift, Release),
                key_event(control, Release),
            ]
        );
    }
}
