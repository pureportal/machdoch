use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// When the user last used the mouse, keyboard or touch input, in Unix
/// milliseconds. `None` where the platform does not report it.
pub(crate) fn last_input_at_millis() -> Option<u64> {
    let idle = idle_duration()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(now.saturating_sub(idle).as_millis()).ok()
}

#[cfg(target_os = "windows")]
fn idle_duration() -> Option<Duration> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: u32::try_from(std::mem::size_of::<LASTINPUTINFO>()).ok()?,
        dwTime: 0,
    };
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return None;
    }
    let idle_ms = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
    Some(Duration::from_millis(u64::from(idle_ms)))
}

#[cfg(target_os = "macos")]
fn idle_duration() -> Option<Duration> {
    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = u32::MAX;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(source_state: i32, event_type: u32) -> f64;
    }

    let seconds =
        unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
    (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn idle_duration() -> Option<Duration> {
    None
}

#[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
mod tests {
    use super::last_input_at_millis;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reports_a_moment_in_the_past() {
        let now = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        let last_input_at = last_input_at_millis().expect("the platform reports input times");
        assert!(last_input_at <= now);
    }
}
