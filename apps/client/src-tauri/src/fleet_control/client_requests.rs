use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
type PendingRequest = oneshot::Sender<Result<Value, String>>;

#[derive(Default)]
pub(crate) struct FleetClientRequestState(Mutex<HashMap<String, PendingRequest>>);

pub(super) async fn invoke(
    app: &tauri::AppHandle,
    command: &str,
    args: &Value,
) -> Result<Value, Value> {
    let id = format!(
        "fleet-client:{}:{}",
        std::process::id(),
        NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)
    );
    let state = app.state::<FleetClientRequestState>();
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = state
            .0
            .lock()
            .map_err(|_| json!("The client is unavailable. Reconnect the device."))?;
        if pending.len() >= 16 {
            return Err(json!(
                "The client is busy. Wait for an operation to finish."
            ));
        }
        pending.insert(id.clone(), sender);
    }
    let emitted = app.emit_to(
        "main",
        "machdoch://fleet-client-request",
        json!({"id": id, "command": command, "args": args}),
    );
    let result = match emitted {
        Err(error) => Err(json!(format!(
            "The client could not receive the request: {error}"
        ))),
        Ok(()) => match tokio::time::timeout(Duration::from_secs(30), receiver).await {
            Ok(Ok(result)) => result.map_err(|error| json!(error)),
            Ok(Err(_)) => Err(json!(
                "The client closed during the request. Reconnect the device."
            )),
            Err(_) => Err(json!(
                "The client did not confirm the request. Refresh before retrying."
            )),
        },
    };
    state
        .0
        .lock()
        .map_err(|_| json!("The client is unavailable. Reconnect the device."))?
        .remove(&id);
    result
}

#[tauri::command]
pub(crate) fn complete_fleet_client_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FleetClientRequestState>,
    id: String,
    result: Value,
    error: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Requests must be confirmed by the main client window.".to_string());
    }
    let sender = state
        .0
        .lock()
        .map_err(|_| "The client is unavailable. Reconnect the device.".to_string())?
        .remove(&id)
        .ok_or_else(|| "The client request expired. Refresh before retrying.".to_string())?;
    sender
        .send(match error {
            Some(error) => Err(error),
            None => Ok(result),
        })
        .map_err(|_| "The client request expired. Refresh before retrying.".to_string())
}
