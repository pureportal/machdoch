use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Listener, Manager};

const MAX_OPERATIONS: usize = 128;
const MAX_ACTIVE: usize = 8;
const MAX_RESULT_BYTES: usize = 64 * 1024 * 1024;
const CHUNK_BYTES: usize = 262_144;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Invoke {
        id: String,
        command: String,
        args: Value,
    },
    Read {
        id: String,
        offset: usize,
    },
    Events {
        after: u64,
    },
    Release {
        id: String,
    },
}

struct Operation {
    digest: Vec<u8>,
    result: Option<Result<String, Value>>,
    touched: Instant,
}

#[derive(Default)]
struct Inner {
    operations: HashMap<String, Operation>,
    events: VecDeque<(u64, String, Value)>,
    cursor: u64,
}

#[derive(Default, Clone)]
pub(crate) struct FleetMediaState(Arc<Mutex<Inner>>);

pub(crate) fn initialize(app: &tauri::AppHandle) {
    for name in ["media-import-progress", "media-civitai-download-progress"] {
        let state = app.state::<FleetMediaState>().inner().clone();
        app.listen(name, move |event| {
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            let Ok(mut inner) = state.0.lock() else {
                return;
            };
            inner.cursor += 1;
            let cursor = inner.cursor;
            inner.events.push_back((cursor, name.to_string(), payload));
            while inner.events.len() > 256 {
                inner.events.pop_front();
            }
        });
    }
}

pub(crate) fn handle(app: &tauri::AppHandle, request: Value) -> Value {
    match handle_request(app, request) {
        Ok(response) => response,
        Err(error) => json!({ "state": "failed", "error": error }),
    }
}

fn handle_request(app: &tauri::AppHandle, request: Value) -> Result<Value, Value> {
    let request: Request =
        serde_json::from_value(request).map_err(|error| json!(error.to_string()))?;
    let state = app.state::<FleetMediaState>();
    let mut inner = state
        .0
        .lock()
        .map_err(|_| json!("Media state is unavailable."))?;
    inner.operations.retain(|_, operation| {
        operation.result.is_none() || operation.touched.elapsed() < Duration::from_secs(600)
    });
    match request {
        Request::Release { id } => {
            if inner
                .operations
                .get(&id)
                .is_some_and(|op| op.result.is_none())
            {
                return Err(json!("Media operation is still running."));
            }
            inner.operations.remove(&id);
            Ok(json!({ "state": "complete", "chunk": "", "offset": 0, "total": 0 }))
        }
        Request::Invoke { id, command, args } => {
            if id.len() != 36
                || !id.bytes().enumerate().all(|(index, byte)| {
                    if [8, 13, 18, 23].contains(&index) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                })
            {
                return Err(json!("Invalid media operation ID."));
            }
            let encoded = serde_json::to_vec(&json!([command, args]))
                .map_err(|error| json!(error.to_string()))?;
            if encoded.len() > 1_048_576 {
                return Err(json!("Media request is too large."));
            }
            let digest = Sha256::digest(&encoded).to_vec();
            if let Some(operation) = inner.operations.get_mut(&id) {
                if operation.digest != digest {
                    return Err(json!(
                        "Media operation ID was reused with different arguments."
                    ));
                }
                operation.touched = Instant::now();
                return Ok(json!({ "state": "pending" }));
            }
            let control = ["media_cancel_", "media_get_", "media_list_", "media_read_"]
                .iter()
                .any(|prefix| command.starts_with(prefix));
            let active_limit = if control { MAX_ACTIVE + 8 } else { MAX_ACTIVE };
            if inner.operations.len() >= MAX_OPERATIONS
                || inner
                    .operations
                    .values()
                    .filter(|op| op.result.is_none())
                    .count()
                    >= active_limit
            {
                return Err(json!(
                    "Media operation queue is full. Wait for an operation to finish."
                ));
            }
            inner.operations.insert(
                id.clone(),
                Operation {
                    digest,
                    result: None,
                    touched: Instant::now(),
                },
            );
            let shared = state.0.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let worker = tauri::async_runtime::spawn(async move {
                    super::fleet_dispatch::invoke(app, command, args).await
                });
                let result = match worker.await {
                    Ok(result) => result.and_then(|value| {
                        let bytes =
                            serde_json::to_vec(&value).map_err(|error| json!(error.to_string()))?;
                        if bytes.len() > MAX_RESULT_BYTES * 3 / 4 {
                            return Err(json!("Media response is too large."));
                        }
                        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
                    }),
                    Err(error) => Err(json!(format!("Media worker failed: {error}"))),
                };
                if let Ok(mut inner) = shared.lock() {
                    let retained_bytes: usize = inner
                        .operations
                        .values()
                        .filter_map(|op| {
                            op.result
                                .as_ref()
                                .and_then(|value| value.as_ref().ok())
                                .map(String::len)
                        })
                        .sum();
                    let result = if result
                        .as_ref()
                        .is_ok_and(|value| retained_bytes + value.len() > 128 * 1024 * 1024)
                    {
                        Err(json!(
                            "Media result storage is full. Finish reading pending operations."
                        ))
                    } else {
                        result
                    };
                    if let Some(operation) = inner.operations.get_mut(&id) {
                        operation.result = Some(result);
                        operation.touched = Instant::now();
                    }
                }
            });
            Ok(json!({ "state": "pending" }))
        }
        Request::Read { id, offset } => {
            let operation = inner.operations.get_mut(&id).ok_or_else(|| {
                json!("Media operation expired. Refresh and check Activity before retrying.")
            })?;
            operation.touched = Instant::now();
            match &operation.result {
                None => Ok(json!({ "state": "pending" })),
                Some(Err(error)) => Err(error.clone()),
                Some(Ok(result)) => {
                    if offset > result.len() {
                        return Err(json!("Invalid media response offset."));
                    }
                    let end = result.len().min(offset + CHUNK_BYTES);
                    Ok(
                        json!({ "state": "complete", "chunk": &result[offset..end], "offset": offset, "total": result.len() }),
                    )
                }
            }
        }
        Request::Events { after } => Ok(json!({
            "state": "events", "cursor": inner.cursor,
            "events": inner.events.iter().filter(|(cursor, _, _)| *cursor > after).map(|(_, name, payload)| json!({ "name": name, "payload": payload })).collect::<Vec<_>>()
        })),
    }
}
