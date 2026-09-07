use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use crate::runtime_contract_generated::{
    MAX_DESKTOP_SETTING_CHAT_IDLE_TIMEOUT_MINUTES, MIN_DESKTOP_SETTING_CHAT_IDLE_TIMEOUT_MINUTES,
};

use super::progress::create_progress_timestamp;

struct TimeoutState {
    started_at: u64,
    last_activity_at: u64,
    last_activity: Instant,
    idle_timeout_ms: u64,
    finished: bool,
    cancellable: bool,
}

impl TimeoutState {
    fn mark_activity(&mut self) {
        self.last_activity = Instant::now();
        self.last_activity_at = create_progress_timestamp();
    }

    fn snapshot(&self) -> Value {
        json!({
            "startedAt": self.started_at,
            "lastActivityAt": self.last_activity_at,
            "idleTimeoutMs": self.idle_timeout_ms,
            "absoluteTimeoutMs": null,
        })
    }
}

pub(super) struct DesktopTaskTimeout {
    pub(super) window_label: String,
    state: Mutex<TimeoutState>,
}

impl DesktopTaskTimeout {
    pub(super) fn new(window_label: String, idle_timeout_minutes: u32) -> Self {
        let timestamp = create_progress_timestamp();
        Self {
            window_label,
            state: Mutex::new(TimeoutState {
                started_at: timestamp,
                last_activity_at: timestamp,
                last_activity: Instant::now(),
                idle_timeout_ms: u64::from(idle_timeout_minutes) * 60_000,
                finished: false,
                cancellable: true,
            }),
        }
    }

    pub(super) fn record_progress(
        &self,
        mut progress: Value,
        emit: impl FnOnce(Value),
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The chat timeout is unavailable.")?;
        if state.finished {
            return Ok(());
        }
        state.mark_activity();
        state.cancellable = progress["cancellable"].as_bool().unwrap_or(false);
        progress["timeout"] = state.snapshot();
        emit(progress);
        Ok(())
    }

    pub(super) fn reset(
        &self,
        idle_timeout_minutes: Option<u32>,
        emit: impl FnOnce(Value),
    ) -> Result<(), String> {
        if idle_timeout_minutes.is_some_and(|minutes| {
            !(MIN_DESKTOP_SETTING_CHAT_IDLE_TIMEOUT_MINUTES
                ..=MAX_DESKTOP_SETTING_CHAT_IDLE_TIMEOUT_MINUTES)
                .contains(&minutes)
        }) {
            return Err(format!("Enter a timeout between {MIN_DESKTOP_SETTING_CHAT_IDLE_TIMEOUT_MINUTES} and {MAX_DESKTOP_SETTING_CHAT_IDLE_TIMEOUT_MINUTES} minutes."));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The chat timeout is unavailable.")?;
        if state.finished || !state.cancellable {
            return Err("This chat run has already stopped.".to_string());
        }
        if let Some(minutes) = idle_timeout_minutes {
            state.idle_timeout_ms = u64::from(minutes) * 60_000;
        }
        state.mark_activity();
        emit(state.snapshot());
        Ok(())
    }

    pub(super) fn expire_if_idle(&self) -> Result<Option<u64>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The chat timeout is unavailable.")?;
        if state.finished
            || state.last_activity.elapsed() < Duration::from_millis(state.idle_timeout_ms)
        {
            return Ok(None);
        }
        state.finished = true;
        Ok(Some(state.idle_timeout_ms))
    }

    pub(super) fn finish(&self) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "The chat timeout is unavailable.")?
            .finished = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn elapse(timeout: &DesktopTaskTimeout, seconds: u64) {
        timeout.state.lock().unwrap().last_activity = Instant::now() - Duration::from_secs(seconds);
    }

    #[test]
    fn reset_extends_the_deadline_and_publishes_the_enforced_timeout() {
        let timeout = DesktopTaskTimeout::new("main".to_string(), 20);
        elapse(&timeout, 1199);
        timeout
            .reset(None, |state| assert_eq!(state["idleTimeoutMs"], 1_200_000))
            .unwrap();
        elapse(&timeout, 2);
        assert_eq!(timeout.expire_if_idle().unwrap(), None);
        elapse(&timeout, 1200);
        assert_eq!(timeout.expire_if_idle().unwrap(), Some(1_200_000));
        assert!(timeout.reset(None, |_| {}).is_err());
    }

    #[test]
    fn changing_the_duration_restarts_the_timer_and_rejects_invalid_values() {
        let timeout = DesktopTaskTimeout::new("main".to_string(), 20);
        elapse(&timeout, 1199);
        assert!(timeout.reset(Some(0), |_| {}).is_err());
        assert!(timeout.reset(Some(1441), |_| {}).is_err());
        timeout
            .reset(Some(40), |state| {
                assert_eq!(state["idleTimeoutMs"], 2_400_000)
            })
            .unwrap();
        elapse(&timeout, 1201);
        assert_eq!(timeout.expire_if_idle().unwrap(), None);
        elapse(&timeout, 2400);
        assert_eq!(timeout.expire_if_idle().unwrap(), Some(2_400_000));
    }

    #[test]
    fn progress_refreshes_the_same_deadline_and_replaces_cli_timeout_metadata() {
        let timeout = DesktopTaskTimeout::new("main".to_string(), 30);
        elapse(&timeout, 1799);
        timeout
            .record_progress(
                json!({"cancellable": true, "timeout": {"idleTimeoutMs": 1}}),
                |progress| {
                    assert_eq!(progress["timeout"]["idleTimeoutMs"], 1_800_000);
                    assert_eq!(progress["timeout"]["absoluteTimeoutMs"], Value::Null);
                },
            )
            .unwrap();
        assert_eq!(timeout.expire_if_idle().unwrap(), None);
        timeout
            .record_progress(json!({"cancellable": false}), |_| {})
            .unwrap();
        assert!(timeout.reset(None, |_| {}).is_err());
        timeout.finish().unwrap();
        assert!(timeout.reset(None, |_| {}).is_err());
    }
}
