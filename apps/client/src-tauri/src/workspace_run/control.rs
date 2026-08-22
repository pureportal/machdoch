use std::{
    io::{BufRead, BufReader, Read as _, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde::{Deserialize, Serialize};

use super::manager::RunManager;

const MAX_REQUEST_BYTES: u64 = 64 * 1024;

#[derive(Clone)]
pub struct ControlCredentials {
    pub address: String,
    pub token: String,
}

pub struct RunControlBridge {
    credentials: ControlCredentials,
    shutdown: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl RunControlBridge {
    pub fn start(manager: Arc<RunManager>) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("Failed to bind the run-control bridge: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Failed to configure the run-control bridge: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Failed to resolve the run-control address: {error}"))?
            .to_string();
        let token = create_token()?;
        let credentials = ControlCredentials { address, token };
        let worker_credentials = credentials.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = shutdown.clone();
        let worker = thread::spawn(move || {
            while !worker_shutdown.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = handle_connection(stream, &manager, &worker_credentials.token);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(100)),
                }
            }
        });

        Ok(Self {
            credentials,
            shutdown,
            worker: Some(worker),
        })
    }

    pub fn credentials(&self) -> ControlCredentials {
        self.credentials.clone()
    }

    pub fn shutdown(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for RunControlBridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlRequest {
    token: String,
    action: ControlAction,
    workspace_root: String,
    configuration_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ControlAction {
    Status,
    Start,
    Stop,
    Restart,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlResponse {
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

fn handle_connection(
    mut stream: TcpStream,
    manager: &Arc<RunManager>,
    expected_token: &str,
) -> Result<(), String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut request_line = String::new();
    BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("Failed to read a run-control request: {error}"))?
            .take(MAX_REQUEST_BYTES),
    )
    .read_line(&mut request_line)
    .map_err(|error| format!("Failed to read a run-control request: {error}"))?;

    let response = match serde_json::from_str::<ControlRequest>(request_line.trim()) {
        Ok(request) if constant_time_equal(request.token.as_bytes(), expected_token.as_bytes()) => {
            execute_request(manager, request)
        }
        Ok(_) => Err("Run-control authentication failed.".to_string()),
        Err(error) => Err(format!("Invalid run-control request: {error}")),
    };
    let response = match response {
        Ok(result) => ControlResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => ControlResponse {
            ok: false,
            result: None,
            error: Some(error),
        },
    };
    let serialized = serde_json::to_string(&response)
        .map_err(|error| format!("Failed to serialize a run-control response: {error}"))?;
    stream
        .write_all(format!("{serialized}\n").as_bytes())
        .and_then(|()| stream.flush())
        .map_err(|error| format!("Failed to write a run-control response: {error}"))
}

fn execute_request(
    manager: &Arc<RunManager>,
    request: ControlRequest,
) -> Result<serde_json::Value, String> {
    let configuration_id = request.configuration_id.as_deref();
    let result = match request.action {
        ControlAction::Status => serialize_snapshot(manager.snapshot(&request.workspace_root)?),
        ControlAction::Start => {
            serialize_snapshot(manager.start(&request.workspace_root, configuration_id)?)
        }
        ControlAction::Stop => {
            serialize_snapshot(manager.stop(&request.workspace_root, configuration_id)?)
        }
        ControlAction::Restart => {
            serialize_snapshot(manager.restart(&request.workspace_root, configuration_id)?)
        }
    };
    result.map_err(|error| format!("Failed to serialize run-control state: {error}"))
}

fn serialize_snapshot(
    mut snapshot: super::model::RunWorkspaceSnapshot,
) -> Result<serde_json::Value, serde_json::Error> {
    super::trim_snapshot_for_ai(&mut snapshot);
    serde_json::to_value(snapshot)
}

fn create_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Secure random generation is unavailable for run control.".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}
