use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, SyncSender},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};

const MAIN_WINDOW_LABEL: &str = "main";
const REQUEST_EVENT: &str = "machdoch://app-control-request";
const CANCEL_EVENT: &str = "machdoch://app-control-cancel";
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_PENDING_REQUESTS: usize = 16;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_TIMEOUT: Duration = Duration::from_secs(16 * 60);

type PendingRequest = SyncSender<Result<Value, String>>;

#[derive(Default)]
pub(crate) struct AppControlState {
    attached: AtomicBool,
    next_request: AtomicU64,
    pending: Mutex<HashMap<String, PendingRequest>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AppControlRequest {
    Snapshot {},
    Run {
        action_id: String,
        #[serde(default)]
        input: Map<String, Value>,
        mode: AppControlMode,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AppControlMode {
    Ask,
    Machdoch,
}

impl AppControlRequest {
    fn timeout(&self) -> Duration {
        match self {
            Self::Snapshot {} => SNAPSHOT_TIMEOUT,
            Self::Run { .. } => RUN_TIMEOUT,
        }
    }

    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Snapshot {} => Ok(()),
            Self::Run { action_id, .. } => {
                let valid = !action_id.is_empty()
                    && action_id.len() <= 120
                    && action_id.chars().all(|character| {
                        character.is_ascii_alphanumeric() || "._-".contains(character)
                    });
                if valid {
                    Ok(())
                } else {
                    Err("Machdoch action ids contain only letters, digits, dots, dashes, and underscores.".to_string())
                }
            }
        }
    }
}

impl AppControlState {
    fn insert(&self, sender: PendingRequest) -> Result<String, String> {
        let id = format!(
            "app-control:{}",
            self.next_request.fetch_add(1, Ordering::Relaxed)
        );
        let mut pending = self.lock()?;
        if pending.len() >= MAX_PENDING_REQUESTS {
            return Err(
                "Machdoch is busy with other app actions. Retry when they finish.".to_string(),
            );
        }
        pending.insert(id.clone(), sender);
        Ok(id)
    }

    fn take(&self, id: &str) -> Result<Option<PendingRequest>, String> {
        Ok(self.lock()?.remove(id))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, PendingRequest>>, String> {
        self.pending
            .lock()
            .map_err(|_| "Machdoch app control is unavailable.".to_string())
    }

    fn wait(
        &self,
        id: &str,
        receiver: mpsc::Receiver<Result<Value, String>>,
        timeout: Duration,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Wait, String> {
        let deadline = Instant::now() + timeout;
        let outcome = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break Wait::TimedOut;
            }
            match receiver.recv_timeout(remaining.min(CANCEL_POLL_INTERVAL)) {
                Ok(response) => break Wait::Answered(response),
                Err(RecvTimeoutError::Disconnected) => break Wait::Closed,
                Err(RecvTimeoutError::Timeout) if cancelled() => break Wait::Cancelled,
                Err(RecvTimeoutError::Timeout) => {}
            }
        };
        self.take(id)?;
        Ok(outcome)
    }

    fn detach(&self) -> Result<(), String> {
        self.attached.store(false, Ordering::SeqCst);
        self.lock()?.clear();
        Ok(())
    }
}

enum Wait {
    Answered(Result<Value, String>),
    Cancelled,
    TimedOut,
    Closed,
}

pub(crate) fn request(
    app: &tauri::AppHandle,
    request: AppControlRequest,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value, String> {
    request.validate()?;
    let state = app.state::<AppControlState>();
    if !state.attached.load(Ordering::SeqCst) || app.get_webview_window(MAIN_WINDOW_LABEL).is_none()
    {
        return Err("The Machdoch window is not open yet. Retry in a moment.".to_string());
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let id = state.insert(sender)?;
    let timeout = request.timeout();
    if let Err(error) = app.emit_to(
        MAIN_WINDOW_LABEL,
        REQUEST_EVENT,
        json!({ "id": id, "request": request }),
    ) {
        state.take(&id)?;
        return Err(format!(
            "The Machdoch window could not receive the request: {error}"
        ));
    }
    match state.wait(&id, receiver, timeout, cancelled)? {
        Wait::Answered(response) => response,
        Wait::Closed => Err(
            "The Machdoch window closed or reloaded before it answered. Retry the request."
                .to_string(),
        ),
        Wait::Cancelled => {
            let _ = app.emit_to(MAIN_WINDOW_LABEL, CANCEL_EVENT, json!({ "id": id }));
            Err("The request was cancelled.".to_string())
        }
        Wait::TimedOut => {
            let _ = app.emit_to(MAIN_WINDOW_LABEL, CANCEL_EVENT, json!({ "id": id }));
            Err("The Machdoch window did not answer in time. It may be busy or closed.".to_string())
        }
    }
}

fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err("Only the main Machdoch window answers app control requests.".to_string())
    }
}

#[tauri::command]
pub(crate) fn attach_app_control(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppControlState>,
) -> Result<(), String> {
    require_main_window(&window)?;
    state.lock()?.clear();
    state.attached.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub(crate) fn detach_app_control(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppControlState>,
) -> Result<(), String> {
    require_main_window(&window)?;
    state.detach()
}

#[tauri::command]
pub(crate) fn complete_app_control_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppControlState>,
    id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    require_main_window(&window)?;
    let Some(sender) = state.take(&id)? else {
        return Ok(());
    };
    let _ = sender.send(match error {
        Some(error) => Err(error),
        None => Ok(result.unwrap_or(Value::Null)),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn parses_snapshot_and_run_requests() {
        let snapshot: AppControlRequest =
            serde_json::from_value(json!({ "kind": "snapshot" })).unwrap();
        assert!(matches!(snapshot, AppControlRequest::Snapshot {}));
        let run: AppControlRequest = serde_json::from_value(json!({
            "kind": "run",
            "actionId": "media.add_lora",
            "input": { "addonId": "abc" },
            "mode": "machdoch"
        }))
        .unwrap();
        assert!(run.validate().is_ok());
        assert_eq!(
            serde_json::to_value(&run).unwrap()["actionId"],
            json!("media.add_lora")
        );
        assert!(serde_json::from_value::<AppControlRequest>(json!({
            "kind": "run", "actionId": "x", "mode": "machdoch", "extra": true
        }))
        .is_err());
    }

    #[test]
    fn rejects_malformed_action_ids() {
        let request = AppControlRequest::Run {
            action_id: "media add lora".to_string(),
            input: Map::new(),
            mode: AppControlMode::Machdoch,
        };
        assert!(request.validate().is_err());
    }

    const NEVER: &dyn Fn() -> bool = &|| false;

    #[test]
    fn delivers_completions_and_reports_closed_windows() {
        let state = AppControlState::default();
        let (sender, receiver) = mpsc::sync_channel(1);
        let id = state.insert(sender).unwrap();
        let responder = state.take(&id).unwrap().unwrap();
        thread::spawn(move || responder.send(Ok(json!({ "ok": true }))).unwrap());
        assert!(matches!(
            state.wait(&id, receiver, Duration::from_secs(5), NEVER).unwrap(),
            Wait::Answered(Ok(value)) if value == json!({ "ok": true })
        ));

        let (sender, receiver) = mpsc::sync_channel(1);
        let id = state.insert(sender).unwrap();
        state.detach().unwrap();
        assert!(!state.attached.load(Ordering::SeqCst));
        assert!(matches!(
            state
                .wait(&id, receiver, Duration::from_secs(5), NEVER)
                .unwrap(),
            Wait::Closed
        ));
    }

    #[test]
    fn stops_waiting_when_the_caller_disconnects() {
        let state = AppControlState::default();
        let (sender, receiver) = mpsc::sync_channel(1);
        let id = state.insert(sender).unwrap();
        let started = Instant::now();
        assert!(matches!(
            state
                .wait(&id, receiver, Duration::from_secs(30), &|| true)
                .unwrap(),
            Wait::Cancelled
        ));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(state.lock().unwrap().is_empty());
    }

    #[test]
    fn times_out_and_limits_pending_requests() {
        let state = AppControlState::default();
        let mut receivers = Vec::new();
        for _ in 0..MAX_PENDING_REQUESTS {
            let (sender, receiver) = mpsc::sync_channel(1);
            state.insert(sender).unwrap();
            receivers.push(receiver);
        }
        let (sender, _receiver) = mpsc::sync_channel(1);
        assert!(state.insert(sender).unwrap_err().contains("busy"));

        let state = AppControlState::default();
        let (sender, receiver) = mpsc::sync_channel(1);
        let id = state.insert(sender).unwrap();
        assert!(matches!(
            state
                .wait(&id, receiver, Duration::from_millis(10), NEVER)
                .unwrap(),
            Wait::TimedOut
        ));
        assert!(state.lock().unwrap().is_empty());
    }
}
