use crate::workspace_tools::terminal::{self, WorkspaceTerminalEvent};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager};

#[derive(Default)]
struct Output {
    events: VecDeque<(u64, WorkspaceTerminalEvent)>,
    cursor: u64,
    bytes: usize,
    failed: bool,
}

impl Output {
    fn append(&mut self, event: WorkspaceTerminalEvent) -> Result<(), String> {
        if self.failed {
            return Err("Terminal output is backed up. Reopen the terminal.".to_string());
        }
        let bytes = match &event {
            WorkspaceTerminalEvent::Output { data, .. } => data.len(),
            _ => 0,
        };
        if self.events.len() >= 255 || self.bytes + bytes > 1024 * 1024 {
            let message = "Terminal output is backed up. Reopen the terminal.".to_string();
            self.failed = true;
            self.cursor += 1;
            self.events.push_back((
                self.cursor,
                WorkspaceTerminalEvent::Error {
                    message: message.clone(),
                },
            ));
            return Err(message);
        }
        self.cursor += 1;
        self.bytes += bytes;
        self.events.push_back((self.cursor, event));
        Ok(())
    }

    fn read(&mut self, after: u64) -> Result<Value, String> {
        if after > self.cursor {
            return Err("Invalid terminal output cursor.".to_string());
        }
        while self
            .events
            .front()
            .is_some_and(|(cursor, _)| *cursor <= after)
        {
            if let Some((_, WorkspaceTerminalEvent::Output { data, .. })) = self.events.pop_front()
            {
                self.bytes = self.bytes.saturating_sub(data.len());
            }
        }
        Ok(
            json!({ "cursor": self.cursor, "events": self.events.iter().map(|(_, event)| event).collect::<Vec<_>>() }),
        )
    }
}

struct Session {
    generation: u64,
    workspace: String,
    output: Arc<Mutex<Output>>,
    touched: Instant,
}

#[derive(Default)]
pub(crate) struct FleetWorkspaceTerminalState {
    sessions: Mutex<HashMap<String, Session>>,
    active_generation: AtomicU64,
    start_gate: tokio::sync::Mutex<()>,
}

pub(crate) fn initialize(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            if let Err(error) = close_matching(&app, |session| {
                session.touched.elapsed() > Duration::from_secs(120)
            })
            .await
            {
                eprintln!("Could not close idle remote terminals: {error}");
            }
        }
    });
}

async fn close_matching(
    app: &tauri::AppHandle,
    matches: impl Fn(&Session) -> bool,
) -> Result<usize, String> {
    let state = app.state::<FleetWorkspaceTerminalState>();
    let ids = match state.sessions.lock() {
        Ok(mut sessions) => {
            let ids: Vec<String> = sessions
                .iter()
                .filter(|(_, session)| matches(session))
                .map(|(id, _)| id.clone())
                .collect();
            for id in &ids {
                sessions.remove(id);
            }
            ids
        }
        Err(error) => {
            return Err(format!("Remote terminal registry is unavailable: {error}"));
        }
    };
    let mut errors = Vec::new();
    for id in &ids {
        if let Err(error) = terminal::stop_workspace_terminal(app.state(), id.clone()).await {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(ids.len())
    } else {
        Err(format!(
            "Could not close remote terminals: {}",
            errors.join("; ")
        ))
    }
}

pub(crate) fn activate_generation(app: &tauri::AppHandle, generation: u64) {
    app.state::<FleetWorkspaceTerminalState>()
        .active_generation
        .store(generation, Ordering::SeqCst);
}

pub(crate) async fn close_generation(app: &tauri::AppHandle, generation: u64) {
    let state = app.state::<FleetWorkspaceTerminalState>();
    let _ =
        state
            .active_generation
            .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst);
    if let Err(error) = close_matching(app, |session| session.generation == generation).await {
        eprintln!("Could not close disconnected remote terminals: {error}");
    }
}

pub(crate) async fn invoke(
    app: &tauri::AppHandle,
    command: &str,
    args: &Value,
) -> Result<Value, Value> {
    let request = args.get("request").unwrap_or(args);
    let workspace = request["workspaceRoot"].as_str().unwrap();
    match command {
        "stop_all_workspace_terminals" => {
            let count = terminal::stop_workspace_terminals(app.state(), workspace.to_owned())
                .await
                .map_err(|error| json!(error))?;
            close_matching(app, |session| session.workspace == workspace)
                .await
                .map_err(|error| json!(error))?;
            return Ok(json!(count));
        }
        "discover_workspace_shells" => {
            return serde_json::to_value(
                terminal::discover_workspace_shells()
                    .await
                    .map_err(|error| json!(error))?,
            )
            .map_err(|error| json!(error.to_string()))
        }
        "open_workspace_terminal_host" => {
            terminal::open_workspace_terminal_host(
                workspace.to_owned(),
                args["terminalId"].as_str().unwrap().to_owned(),
            )
            .await
            .map_err(|error| json!(error))?;
            return Ok(Value::Null);
        }
        "stop_workspace_terminals" => {
            return Ok(json!(close_matching(app, |session| session.workspace
                == workspace)
            .await
            .map_err(|error| json!(error))?))
        }
        "start_workspace_terminal" => {
            let state = app.state::<FleetWorkspaceTerminalState>();
            let _start = state.start_gate.lock().await;
            let generation = state.active_generation.load(Ordering::SeqCst);
            if generation == 0 {
                return Err(json!("The Fleet connection is no longer active."));
            }
            if state
                .sessions
                .lock()
                .map_err(|error| json!(error.to_string()))?
                .len()
                >= 32
            {
                return Err(json!(
                    "Too many remote terminals. Close a terminal before opening another."
                ));
            }
            let output = Arc::new(Mutex::new(Output::default()));
            let channel_output = output.clone();
            let channel = Channel::<WorkspaceTerminalEvent>::new(move |body| {
                channel_output
                    .lock()
                    .map_err(|error| {
                        tauri::Error::Anyhow(std::io::Error::other(error.to_string()).into())
                    })?
                    .append(body.deserialize::<WorkspaceTerminalEvent>()?)
                    .map_err(|error| tauri::Error::Anyhow(std::io::Error::other(error).into()))
            });
            let started = terminal::start_workspace_terminal(
                app.state(),
                serde_json::from_value(request.clone())
                    .map_err(|error| json!(error.to_string()))?,
                channel,
            )
            .await
            .map_err(|error| json!(error))?;
            let value = serde_json::to_value(started).map_err(|error| json!(error.to_string()))?;
            let id = value["sessionId"].as_str().unwrap().to_owned();
            let inserted = {
                let mut sessions = state
                    .sessions
                    .lock()
                    .map_err(|error| json!(error.to_string()))?;
                if state.active_generation.load(Ordering::SeqCst) == generation {
                    sessions.insert(
                        id.clone(),
                        Session {
                            generation,
                            workspace: workspace.to_owned(),
                            output,
                            touched: Instant::now(),
                        },
                    );
                    true
                } else {
                    false
                }
            };
            if !inserted {
                terminal::stop_workspace_terminal(app.state(), id)
                    .await
                    .map_err(|error| json!(error))?;
                return Err(json!(
                    "The Fleet connection closed during terminal startup."
                ));
            }
            return Ok(value);
        }
        _ => {}
    }
    let id = args["sessionId"]
        .as_str()
        .ok_or_else(|| json!("Expected a terminal session."))?;
    let output = {
        let state = app.state::<FleetWorkspaceTerminalState>();
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|error| json!(error.to_string()))?;
        let session = sessions
            .get_mut(id)
            .filter(|session| session.workspace == workspace)
            .ok_or_else(|| json!("This remote terminal is no longer running."))?;
        session.touched = Instant::now();
        session.output.clone()
    };
    match command {
        "read_workspace_terminal_events" => {
            return output
                .lock()
                .map_err(|error| json!(error.to_string()))?
                .read(args["after"].as_f64().unwrap() as u64)
                .map_err(|error| json!(error))
        }
        "write_workspace_terminal" => {
            terminal::write_workspace_terminal(
                app.state(),
                id.to_owned(),
                args["data"].as_str().unwrap().to_owned(),
            )
            .await
        }
        "write_workspace_terminal_binary" => {
            terminal::write_workspace_terminal_binary(
                app.state(),
                id.to_owned(),
                args["data"].as_str().unwrap().to_owned(),
            )
            .await
        }
        "acknowledge_workspace_terminal_output" => {
            terminal::acknowledge_workspace_terminal_output(
                app.state(),
                id.to_owned(),
                args["bytes"].as_f64().unwrap() as usize,
            )
            .await
        }
        "resize_workspace_terminal" => {
            terminal::resize_workspace_terminal(
                app.state(),
                id.to_owned(),
                args["columns"].as_f64().unwrap() as u16,
                args["rows"].as_f64().unwrap() as u16,
            )
            .await
        }
        "stop_workspace_terminal" => {
            terminal::stop_workspace_terminal(app.state(), id.to_owned())
                .await
                .map_err(|error| json!(error))?;
            app.state::<FleetWorkspaceTerminalState>()
                .sessions
                .lock()
                .map_err(|error| json!(error.to_string()))?
                .remove(id);
            return Ok(Value::Null);
        }
        _ => return Err(json!("Unknown terminal operation.")),
    }
    .map_err(|error| json!(error))?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_replays_retained_output_without_acknowledging_unread_events() {
        let mut output = Output::default();
        output
            .append(WorkspaceTerminalEvent::Output {
                session_id: "terminal-a".into(),
                data: "YQ==".into(),
            })
            .unwrap();
        output
            .append(WorkspaceTerminalEvent::Exit { exit_code: Some(0) })
            .unwrap();
        assert_eq!(output.read(0).unwrap(), output.read(0).unwrap());
        assert_eq!(
            output.read(1).unwrap()["events"].as_array().unwrap().len(),
            1
        );
        assert_eq!(output.bytes, 0);
        assert!(output.read(3).is_err());
        assert!(output.read(2).unwrap()["events"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn terminal_output_cannot_grow_without_a_reader() {
        let mut output = Output::default();
        for _ in 0..255 {
            output
                .append(WorkspaceTerminalEvent::Error {
                    message: "test".into(),
                })
                .unwrap();
        }
        assert!(output
            .append(WorkspaceTerminalEvent::Exit { exit_code: None })
            .is_err());
        assert_eq!(output.events.len(), 256);
        assert!(matches!(
            output.events.back().unwrap().1,
            WorkspaceTerminalEvent::Error { .. }
        ));
        output.read(256).unwrap();
        assert!(output
            .append(WorkspaceTerminalEvent::Exit { exit_code: None })
            .is_err());
        assert!(output.events.is_empty());
    }
}
