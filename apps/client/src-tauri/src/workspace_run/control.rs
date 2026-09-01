use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read as _, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde::{Deserialize, Serialize};

use super::{
    manager::RunManager,
    presence::{WorkspaceAgentRegistration, WorkspacePresenceRegistry},
};
use crate::runtime_snapshot::resolve_workspace_root_path;

const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_ACTIVE_CONNECTIONS: usize = 128;

#[derive(Clone)]
pub struct ControlCredentials {
    pub address: String,
    pub token: String,
    pub presence_token: String,
}

pub struct RunControlBridge {
    credentials: ControlCredentials,
    shutdown: Arc<AtomicBool>,
    active_connections: Arc<Mutex<HashMap<u64, Arc<TcpStream>>>>,
    presence: Arc<WorkspacePresenceRegistry>,
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
        let presence_token = create_token()?;
        let credentials = ControlCredentials {
            address,
            token,
            presence_token,
        };
        let worker_credentials = credentials.clone();
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = shutdown.clone();
        let active_connections = Arc::new(Mutex::new(HashMap::new()));
        let worker_connections = active_connections.clone();
        let presence = Arc::new(WorkspacePresenceRegistry::default());
        let worker_presence = presence.clone();
        let next_connection_id = Arc::new(AtomicU64::new(1));
        let worker_connection_ids = next_connection_id.clone();
        let worker = thread::spawn(move || {
            let mut connection_workers = Vec::new();
            while !worker_shutdown.load(Ordering::SeqCst) {
                reap_finished_connections(&mut connection_workers);
                match listener.accept() {
                    Ok((stream, _)) => {
                        if stream.set_nonblocking(false).is_err() {
                            continue;
                        }
                        let stream = Arc::new(stream);
                        let connection_id = worker_connection_ids.fetch_add(1, Ordering::Relaxed);
                        let connection_tracked = worker_connections
                            .lock()
                            .ok()
                            .filter(|connections| connections.len() < MAX_ACTIVE_CONNECTIONS)
                            .map(|mut connections| {
                                connections.insert(connection_id, stream.clone());
                            })
                            .is_some();
                        if !connection_tracked {
                            continue;
                        }
                        if worker_shutdown.load(Ordering::SeqCst) {
                            let _ = stream.shutdown(Shutdown::Both);
                            if let Ok(mut connections) = worker_connections.lock() {
                                connections.remove(&connection_id);
                            }
                            break;
                        }
                        let connection_manager = manager.clone();
                        let connection_token = worker_credentials.token.clone();
                        let connection_presence_token = worker_credentials.presence_token.clone();
                        let connection_presence = worker_presence.clone();
                        let connection_map = worker_connections.clone();
                        let connection_shutdown = worker_shutdown.clone();
                        connection_workers.push(thread::spawn(move || {
                            let _cleanup = ConnectionCleanup {
                                connection_id,
                                presence: connection_presence.clone(),
                                active_connections: connection_map,
                            };
                            if connection_shutdown.load(Ordering::SeqCst) {
                                return;
                            }
                            let _ = handle_connection(
                                stream,
                                &connection_manager,
                                &connection_presence,
                                connection_id,
                                &connection_token,
                                &connection_presence_token,
                            );
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(100)),
                }
            }
            reap_finished_connections(&mut connection_workers);
            worker_presence.clear();
        });

        Ok(Self {
            credentials,
            shutdown,
            active_connections,
            presence,
            worker: Some(worker),
        })
    }

    pub fn credentials(&self) -> ControlCredentials {
        self.credentials.clone()
    }

    pub fn shutdown(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Ok(connections) = self.active_connections.lock() {
            for stream in connections.values() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.presence.clear();
    }
}

impl Drop for RunControlBridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct ConnectionCleanup {
    connection_id: u64,
    presence: Arc<WorkspacePresenceRegistry>,
    active_connections: Arc<Mutex<HashMap<u64, Arc<TcpStream>>>>,
}

impl Drop for ConnectionCleanup {
    fn drop(&mut self) {
        self.presence.unregister_connection(self.connection_id);
        if let Ok(mut connections) = self.active_connections.lock() {
            connections.remove(&self.connection_id);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlRequest {
    token: String,
    action: ControlAction,
    workspace_root: String,
    configuration_id: Option<String>,
    registration: Option<WorkspaceAgentRegistration>,
    agent_id: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ControlAction {
    Status,
    Start,
    Stop,
    Restart,
    RegisterPresence,
    GetPresence,
    UnregisterPresence,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlResponse {
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

fn handle_connection(
    stream: Arc<TcpStream>,
    manager: &Arc<RunManager>,
    presence: &Arc<WorkspacePresenceRegistry>,
    connection_id: u64,
    expected_control_token: &str,
    expected_presence_token: &str,
) -> Result<(), String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut reader = BufReader::new(stream.as_ref());
    let request = match read_request(&mut reader) {
        Ok(Some(request)) => request,
        Ok(None) => return Ok(()),
        Err(error) => return write_response(stream.as_ref(), Err(error)),
    };
    if !request_is_authenticated(&request, expected_control_token, expected_presence_token) {
        return write_response(
            stream.as_ref(),
            Err("Run-control authentication failed.".to_string()),
        );
    }

    if matches!(request.action, ControlAction::RegisterPresence) {
        let _ = reader.get_mut().set_read_timeout(None);
        return handle_presence_connection(
            stream.as_ref(),
            &mut reader,
            presence,
            connection_id,
            expected_control_token,
            expected_presence_token,
            request,
        );
    }

    write_response(
        stream.as_ref(),
        execute_request(manager, presence, connection_id, request),
    )
}

fn handle_presence_connection(
    stream: &TcpStream,
    reader: &mut BufReader<&TcpStream>,
    presence: &WorkspacePresenceRegistry,
    connection_id: u64,
    expected_control_token: &str,
    expected_presence_token: &str,
    mut request: ControlRequest,
) -> Result<(), String> {
    loop {
        let action = request.action;
        let response = execute_presence_request(presence, connection_id, request);
        write_response(stream, response)?;
        if !matches!(
            action,
            ControlAction::RegisterPresence
                | ControlAction::GetPresence
                | ControlAction::UnregisterPresence
        ) {
            return Ok(());
        }

        let next_request = match read_request(reader) {
            Ok(Some(request)) => request,
            Ok(None) => return Ok(()),
            Err(error) => {
                write_response(stream, Err(error))?;
                return Ok(());
            }
        };
        if !request_is_authenticated(
            &next_request,
            expected_control_token,
            expected_presence_token,
        ) {
            write_response(
                stream,
                Err("Run-control authentication failed.".to_string()),
            )?;
            return Ok(());
        }
        request = next_request;
    }
}

fn read_request<R: BufRead>(reader: &mut R) -> Result<Option<ControlRequest>, String> {
    let mut request_line = String::new();
    let bytes_read = reader
        .take(MAX_REQUEST_BYTES + 1)
        .read_line(&mut request_line)
        .map_err(|error| format!("Failed to read a run-control request: {error}"))?;
    if bytes_read == 0 {
        return Ok(None);
    }
    if bytes_read as u64 > MAX_REQUEST_BYTES || !request_line.ends_with('\n') {
        return Err("Run-control request is too large or incomplete.".to_string());
    }
    serde_json::from_str::<ControlRequest>(request_line.trim_end())
        .map(Some)
        .map_err(|error| format!("Invalid run-control request: {error}"))
}

fn write_response(
    stream: &TcpStream,
    response: Result<serde_json::Value, String>,
) -> Result<(), String> {
    let mut stream = stream;
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

fn request_is_authenticated(
    request: &ControlRequest,
    expected_control_token: &str,
    expected_presence_token: &str,
) -> bool {
    constant_time_equal(request.token.as_bytes(), expected_control_token.as_bytes())
        || (matches!(
            request.action,
            ControlAction::RegisterPresence
                | ControlAction::GetPresence
                | ControlAction::UnregisterPresence
        ) && constant_time_equal(request.token.as_bytes(), expected_presence_token.as_bytes()))
}

fn execute_request(
    manager: &Arc<RunManager>,
    presence: &WorkspacePresenceRegistry,
    connection_id: u64,
    request: ControlRequest,
) -> Result<serde_json::Value, String> {
    match request.action {
        ControlAction::Status => serialize_snapshot(manager.snapshot(&request.workspace_root)?),
        ControlAction::Start => serialize_snapshot(
            manager.start(&request.workspace_root, request.configuration_id.as_deref())?,
        ),
        ControlAction::Stop => serialize_snapshot(
            manager.stop(&request.workspace_root, request.configuration_id.as_deref())?,
        ),
        ControlAction::Restart => serialize_snapshot(
            manager.restart(&request.workspace_root, request.configuration_id.as_deref())?,
        ),
        ControlAction::GetPresence
        | ControlAction::RegisterPresence
        | ControlAction::UnregisterPresence => {
            execute_presence_request(presence, connection_id, request)
        }
    }
}

fn execute_presence_request(
    presence: &WorkspacePresenceRegistry,
    connection_id: u64,
    request: ControlRequest,
) -> Result<serde_json::Value, String> {
    let workspace_root = canonical_workspace_root(&request.workspace_root)?;
    match request.action {
        ControlAction::RegisterPresence => {
            let registration = request.registration.ok_or_else(|| {
                "Workspace presence registration metadata is required.".to_string()
            })?;
            let agent_id = registration.agent_id.clone();
            presence.register(connection_id, workspace_root, registration)?;
            Ok(serde_json::json!({ "registered": true, "agentId": agent_id }))
        }
        ControlAction::GetPresence => {
            serde_json::to_value(presence.snapshot(&workspace_root, request.agent_id.as_deref())?)
                .map_err(|error| format!("Failed to serialize workspace presence: {error}"))
        }
        ControlAction::UnregisterPresence => {
            let agent_id = request
                .agent_id
                .as_deref()
                .ok_or_else(|| "Workspace presence agentId is required for cleanup.".to_string())?;
            presence.unregister_agent(connection_id, agent_id)?;
            Ok(serde_json::json!({ "registered": false, "agentId": agent_id }))
        }
        ControlAction::Status
        | ControlAction::Start
        | ControlAction::Stop
        | ControlAction::Restart => {
            Err("Run-control actions are not valid on a presence connection.".to_string())
        }
    }
}

fn canonical_workspace_root(workspace_root: &str) -> Result<String, String> {
    resolve_workspace_root_path(workspace_root).map(|path| path.display().to_string())
}

fn serialize_snapshot(
    mut snapshot: super::model::RunWorkspaceSnapshot,
) -> Result<serde_json::Value, String> {
    super::trim_snapshot_for_ai(&mut snapshot);
    serde_json::to_value(snapshot)
        .map_err(|error| format!("Failed to serialize run-control state: {error}"))
}

fn reap_finished_connections(connection_workers: &mut Vec<JoinHandle<()>>) {
    let mut index = 0;
    while index < connection_workers.len() {
        if connection_workers[index].is_finished() {
            let worker = connection_workers.swap_remove(index);
            let _ = worker.join();
        } else {
            index += 1;
        }
    }
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

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::PathBuf,
        time::{Instant, SystemTime, UNIX_EPOCH},
    };

    use serde_json::{json, Value};

    use super::*;

    struct PresenceClient {
        stream: TcpStream,
        reader: BufReader<TcpStream>,
    }

    impl PresenceClient {
        fn connect(credentials: &ControlCredentials) -> Self {
            let stream = TcpStream::connect(&credentials.address)
                .expect("presence client should connect to the bridge");
            let reader = BufReader::new(
                stream
                    .try_clone()
                    .expect("presence client stream should clone"),
            );
            Self { stream, reader }
        }

        fn request(&mut self, request: Value) -> Value {
            self.stream
                .write_all(format!("{request}\n").as_bytes())
                .and_then(|()| self.stream.flush())
                .expect("presence request should be written");
            let mut response = String::new();
            self.reader
                .read_line(&mut response)
                .expect("presence response should be read");
            serde_json::from_str(response.trim()).expect("presence response should be JSON")
        }
    }

    fn temporary_workspace(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "machdoch-presence-{}-{}-{name}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("temporary workspace should be created");
        path.canonicalize().expect("workspace should canonicalize")
    }

    fn registration_request(
        credentials: &ControlCredentials,
        workspace: &PathBuf,
        agent_id: &str,
    ) -> Value {
        json!({
            "token": credentials.presence_token,
            "action": "registerPresence",
            "workspaceRoot": workspace,
            "registration": {
                "agentId": agent_id,
                "registrationKey": format!("{agent_id}-key"),
                "role": "parent",
                "access": "write",
                "activity": "executor",
                "claims": {}
            }
        })
    }

    fn query_presence(
        credentials: &ControlCredentials,
        workspace: &PathBuf,
        requester_agent_id: &str,
    ) -> Value {
        let mut client = PresenceClient::connect(credentials);
        client.request(json!({
            "token": credentials.presence_token,
            "action": "getPresence",
            "workspaceRoot": workspace,
            "agentId": requester_agent_id
        }))
    }

    fn wait_for_presence_count(bridge: &RunControlBridge, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while bridge.presence.active_count() != expected && Instant::now() < deadline {
            thread::yield_now();
        }
        assert_eq!(bridge.presence.active_count(), expected);
    }

    #[test]
    fn registers_and_discovers_other_workspace_agents() {
        let workspace = temporary_workspace("discovery");
        let mut bridge =
            RunControlBridge::start(Arc::new(RunManager::default())).expect("bridge should start");
        let credentials = bridge.credentials();
        let mut first = PresenceClient::connect(&credentials);
        let mut second = PresenceClient::connect(&credentials);

        assert_eq!(
            first.request(registration_request(&credentials, &workspace, "agent-a"))["ok"],
            true
        );
        assert_eq!(
            second.request(registration_request(&credentials, &workspace, "agent-b"))["ok"],
            true
        );
        let response = query_presence(&credentials, &workspace, "agent-a");

        assert_eq!(response["result"]["status"], "available");
        assert_eq!(
            response["result"]["agents"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(response["result"]["agents"][0]["agentId"], "agent-b");
        assert!(response["result"]["agents"][0].get("prompt").is_none());
        assert!(response["result"]["agents"][0]
            .get("registrationKey")
            .is_none());

        drop(first);
        drop(second);
        bridge.shutdown();
        fs::remove_dir_all(workspace).expect("temporary workspace should be removed");
    }

    #[test]
    fn unregisters_presence_on_graceful_completion() {
        let workspace = temporary_workspace("graceful");
        let mut bridge =
            RunControlBridge::start(Arc::new(RunManager::default())).expect("bridge should start");
        let credentials = bridge.credentials();
        let mut client = PresenceClient::connect(&credentials);
        client.request(registration_request(&credentials, &workspace, "agent-a"));

        let response = client.request(json!({
            "token": credentials.presence_token,
            "action": "unregisterPresence",
            "workspaceRoot": workspace,
            "agentId": "agent-a"
        }));

        assert_eq!(response["ok"], true);
        assert_eq!(bridge.presence.active_count(), 0);
        bridge.shutdown();
        fs::remove_dir_all(workspace).expect("temporary workspace should be removed");
    }

    #[test]
    fn recovers_stale_presence_after_an_interrupted_connection() {
        let workspace = temporary_workspace("interrupted");
        let mut bridge =
            RunControlBridge::start(Arc::new(RunManager::default())).expect("bridge should start");
        let credentials = bridge.credentials();
        let mut client = PresenceClient::connect(&credentials);
        client.request(registration_request(&credentials, &workspace, "agent-a"));
        wait_for_presence_count(&bridge, 1);

        drop(client);
        wait_for_presence_count(&bridge, 0);
        let response = query_presence(&credentials, &workspace, "observer");

        assert_eq!(response["result"]["status"], "available");
        assert_eq!(response["result"]["agents"], json!([]));
        bridge.shutdown();
        fs::remove_dir_all(workspace).expect("temporary workspace should be removed");
    }

    #[test]
    fn clears_presence_when_the_bridge_shuts_down() {
        let workspace = temporary_workspace("bridge-shutdown");
        let mut bridge =
            RunControlBridge::start(Arc::new(RunManager::default())).expect("bridge should start");
        let credentials = bridge.credentials();
        let mut client = PresenceClient::connect(&credentials);
        client.request(registration_request(&credentials, &workspace, "agent-a"));
        wait_for_presence_count(&bridge, 1);

        bridge.shutdown();

        assert_eq!(bridge.presence.active_count(), 0);
        drop(client);
        fs::remove_dir_all(workspace).expect("temporary workspace should be removed");
    }

    #[test]
    fn presence_credentials_cannot_execute_run_control_actions() {
        let workspace = temporary_workspace("presence-auth");
        let mut bridge =
            RunControlBridge::start(Arc::new(RunManager::default())).expect("bridge should start");
        let credentials = bridge.credentials();
        let mut client = PresenceClient::connect(&credentials);

        let response = client.request(json!({
            "token": credentials.presence_token,
            "action": "status",
            "workspaceRoot": workspace
        }));

        assert_eq!(response["ok"], false);
        assert_eq!(response["error"], "Run-control authentication failed.");
        bridge.shutdown();
        fs::remove_dir_all(workspace).expect("temporary workspace should be removed");
    }
}
