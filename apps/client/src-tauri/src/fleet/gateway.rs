use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use machdoch_fleet_protocol::{
    serialize_host_message, HostErrorCode, HostMessage, HostResponse, ManagerMessage,
    GATEWAY_PROTOCOL_VERSION, MAX_GATEWAY_MESSAGE_BYTES, PRODUCT_CAPABILITY,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        http::HeaderValue,
        protocol::{
            frame::{coding::CloseCode, CloseFrame},
            WebSocketConfig,
        },
        Message,
    },
};

use super::{
    config::{validate_fleet_manager_url, FleetConnectionConfig},
    http::normalized_manager_message,
    now_seconds, FleetConnectionInner, FleetConnectionPhase,
};

const GATEWAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const GATEWAY_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const GATEWAY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_QUEUED_REQUESTS: usize = 32;
const MAX_QUEUED_REQUEST_BYTES: usize = 2 * MAX_GATEWAY_MESSAGE_BYTES;
// A disconnected generation may still be finishing disk I/O. Never start an unbounded
// number of blocking workers across reconnects or configuration changes.
static REQUEST_WORKER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

pub(super) async fn run(
    app_handle: tauri::AppHandle,
    state: Arc<Mutex<FleetConnectionInner>>,
    config: FleetConnectionConfig,
    generation: u64,
) {
    let mut reconnect_delay = Duration::from_secs(1);
    loop {
        if !is_current(&state, generation) {
            return;
        }
        set_phase(&state, generation, FleetConnectionPhase::Connecting, None);
        let started = tokio::time::Instant::now();
        // Cancellation covers DNS, TLS, blocked writes, and reconnects as well as idle sockets.
        let result = tokio::select! {
            biased;
            _ = wait_for_generation_change(&state, generation) => return,
            result = connect_once(&app_handle, &state, &config, generation) => result,
        };
        match result {
            ConnectionResult::Reset => return,
            ConnectionResult::Stopped(error) => {
                set_phase(&state, generation, FleetConnectionPhase::Error, Some(error));
                return;
            }
            ConnectionResult::Reconnect(error) => {
                set_phase(&state, generation, FleetConnectionPhase::Error, Some(error));
            }
        }
        reconnect_delay = reconnect_backoff(reconnect_delay, started.elapsed());
        if !wait_for_reconnect(&state, generation, jittered_delay(reconnect_delay)).await {
            return;
        }
    }
}

enum ConnectionResult {
    Reset,
    Reconnect(String),
    Stopped(String),
}

async fn connect_once(
    app_handle: &tauri::AppHandle,
    state: &Arc<Mutex<FleetConnectionInner>>,
    config: &FleetConnectionConfig,
    generation: u64,
) -> ConnectionResult {
    let gateway_url = match gateway_url(&config.manager_url, &config.instance_id) {
        Ok(url) => url,
        Err(error) => return ConnectionResult::Stopped(error),
    };
    let mut request = match gateway_url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => {
            return ConnectionResult::Stopped(format!("Fleet gateway URL is invalid: {error}"))
        }
    };
    let authorization = match HeaderValue::from_str(&format!("Bearer {}", config.instance_secret)) {
        Ok(value) => value,
        Err(_) => {
            return ConnectionResult::Stopped("Fleet gateway credential is invalid.".to_string())
        }
    };
    request.headers_mut().insert("authorization", authorization);
    let mut websocket_config = WebSocketConfig::default();
    websocket_config.max_message_size = Some(MAX_GATEWAY_MESSAGE_BYTES);
    websocket_config.max_frame_size = Some(MAX_GATEWAY_MESSAGE_BYTES);
    let connection = match tokio::time::timeout(
        GATEWAY_CONNECT_TIMEOUT,
        connect_async_with_config(request, Some(websocket_config), false),
    )
    .await
    {
        Ok(connection) => connection,
        Err(_) => {
            return ConnectionResult::Reconnect(
                "Fleet gateway connection attempt timed out.".to_string(),
            )
        }
    };
    let (socket, _) = match connection {
        Ok(connection) => connection,
        Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if permanent_upgrade_status(response.status().as_u16()) =>
        {
            return ConnectionResult::Stopped(
                "Fleet Manager rejected the instance credentials.".to_string(),
            );
        }
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            return ConnectionResult::Reconnect(format!(
                "Fleet gateway connection failed (HTTP {}).",
                response.status().as_u16()
            ));
        }
        Err(error) => {
            return ConnectionResult::Reconnect(format!("Fleet gateway connection failed: {error}"))
        }
    };
    let (mut sender, mut receiver) = socket.split();
    let hello = HostMessage::Hello {
        instance_id: config.instance_id.clone(),
        protocol_version: GATEWAY_PROTOCOL_VERSION,
        product_version: app_handle.package_info().version.to_string(),
        capabilities: vec![PRODUCT_CAPABILITY.to_string()],
    };
    if send_host_message(&mut sender, &hello).await.is_err() {
        return ConnectionResult::Reconnect(
            "Fleet gateway closed during authentication.".to_string(),
        );
    }
    set_phase(state, generation, FleetConnectionPhase::Connected, None);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_received = tokio::time::Instant::now();
    let mut requests = VecDeque::new();
    let mut queued_bytes = 0usize;
    let mut work: Option<tokio::task::JoinHandle<Result<String, String>>> = None;

    loop {
        if !is_current(state, generation) {
            return ConnectionResult::Reset;
        }
        if work.is_none() && !requests.is_empty() {
            if let Ok(permit) = REQUEST_WORKER.try_acquire() {
                let (request_id, request, bytes) = requests.pop_front().expect("queued request");
                queued_bytes = queued_bytes.saturating_sub(bytes);
                let app_handle = app_handle.clone();
                let state = state.clone();
                // Serialize disk-backed command work without blocking the async runtime or heartbeats.
                work = Some(tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let response = if is_current(&state, generation) {
                        crate::fleet_control::handle_fleet_request(&app_handle, request)
                    } else {
                        HostResponse::Error {
                            code: HostErrorCode::Unavailable,
                            message: "Fleet connection changed.".to_string(),
                        }
                    };
                    encode_host_message(&HostMessage::Response {
                        request_id,
                        response,
                    })
                }));
            }
        }
        tokio::select! {
            _ = REQUEST_WORKER.acquire(), if work.is_none() && !requests.is_empty() => {}
            _ = heartbeat.tick() => {
                if send_host_message(&mut sender, &HostMessage::Heartbeat { sent_at: now_seconds() }).await.is_err() {
                    return ConnectionResult::Reconnect("Fleet gateway connection closed.".to_string());
                }
                // Older managers do not send periodic pings; solicit their WebSocket pong.
                if send_message(&mut sender, Message::Ping(Vec::new().into()), GATEWAY_WRITE_TIMEOUT).await.is_err() {
                    return ConnectionResult::Reconnect("Fleet gateway connection closed.".to_string());
                }
            }
            _ = tokio::time::sleep_until(last_received + GATEWAY_IDLE_TIMEOUT) => {
                return ConnectionResult::Reconnect("Fleet Manager stopped responding.".to_string());
            }
            completed = async { work.as_mut().expect("guarded worker").await }, if work.is_some() => {
                work = None;
                if !is_current(state, generation) {
                    return ConnectionResult::Reset;
                }
                match completed {
                    Ok(Ok(payload)) => {
                        if send_message(&mut sender, Message::Text(payload.into()), GATEWAY_WRITE_TIMEOUT).await.is_err() {
                            return ConnectionResult::Reconnect("Fleet gateway connection closed.".to_string());
                        }
                    }
                    Ok(Err(_)) | Err(_) => return ConnectionResult::Reconnect("Fleet request worker failed.".to_string()),
                }
            }
            inbound = receiver.next() => {
                if !is_current(state, generation) {
                    return ConnectionResult::Reset;
                }
                last_received = tokio::time::Instant::now();
                match inbound {
                    Some(Ok(Message::Text(payload))) => {
                        if payload.len() > MAX_GATEWAY_MESSAGE_BYTES {
                            return ConnectionResult::Stopped("Fleet gateway message exceeded the configured limit.".to_string());
                        }
                        match serde_json::from_str::<ManagerMessage>(&payload) {
                            Ok(ManagerMessage::Request { request_id, request }) => {
                                if requests.len() >= MAX_QUEUED_REQUESTS || queued_bytes + payload.len() > MAX_QUEUED_REQUEST_BYTES {
                                    let response = HostResponse::Error { code: HostErrorCode::Unavailable,
                                        message: "Fleet command queue is full; retry after pending requests finish.".to_string() };
                                    if send_host_message(&mut sender, &HostMessage::Response { request_id, response }).await.is_err() {
                                        return ConnectionResult::Reconnect("Fleet gateway connection closed.".to_string());
                                    }
                                } else {
                                    queued_bytes += payload.len();
                                    requests.push_back((request_id, request, payload.len()));
                                }
                            }
                            Ok(ManagerMessage::Disconnect { reason }) => {
                                return ConnectionResult::Stopped(
                                    normalized_manager_message(&reason, 500).unwrap_or_else(|| {
                                        "Fleet Manager disconnected the instance.".to_string()
                                    }),
                                )
                            }
                            Err(_) => return ConnectionResult::Stopped("Fleet Manager sent an invalid gateway message.".to_string()),
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if send_message(&mut sender, Message::Pong(payload), GATEWAY_WRITE_TIMEOUT).await.is_err() {
                            return ConnectionResult::Reconnect("Fleet gateway connection closed.".to_string());
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(frame))) => return connection_result_from_close(frame),
                    None => return ConnectionResult::Reconnect("Fleet gateway connection closed.".to_string()),
                    Some(Err(tokio_tungstenite::tungstenite::Error::Capacity(_))) => {
                        return ConnectionResult::Stopped("Fleet gateway message exceeded the configured limit.".to_string())
                    }
                    Some(Err(
                        tokio_tungstenite::tungstenite::Error::Protocol(_)
                        | tokio_tungstenite::tungstenite::Error::Utf8(_)
                        | tokio_tungstenite::tungstenite::Error::AttackAttempt,
                    )) => {
                        return ConnectionResult::Stopped("Fleet Manager sent an invalid gateway message.".to_string())
                    }
                    Some(Err(error)) => return ConnectionResult::Reconnect(format!("Fleet gateway connection failed: {error}")),
                    Some(Ok(Message::Binary(_))) | Some(Ok(Message::Frame(_))) => {
                        return ConnectionResult::Stopped("Fleet Manager sent an unsupported gateway message.".to_string())
                    }
                }
            }
        }
    }
}

fn connection_result_from_close(frame: Option<CloseFrame>) -> ConnectionResult {
    let Some(frame) = frame else {
        return ConnectionResult::Reconnect("Fleet gateway connection closed.".to_string());
    };
    let reason = normalized_manager_message(&frame.reason, 500);
    let permanent = matches!(
        frame.code,
        CloseCode::Protocol
            | CloseCode::Unsupported
            | CloseCode::Invalid
            | CloseCode::Policy
            | CloseCode::Size
            | CloseCode::Extension
    );
    if permanent {
        return ConnectionResult::Stopped(if let Some(reason) = reason {
            format!("Fleet Manager rejected the connection: {reason}")
        } else {
            format!("Fleet Manager rejected the connection ({}).", frame.code)
        });
    }
    ConnectionResult::Reconnect(if let Some(reason) = reason {
        format!("Fleet gateway connection closed: {reason}")
    } else {
        format!("Fleet gateway connection closed ({}).", frame.code)
    })
}

async fn send_host_message<S>(sender: &mut S, message: &HostMessage) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let payload = encode_host_message(message)?;
    send_message(sender, Message::Text(payload.into()), GATEWAY_WRITE_TIMEOUT).await
}

fn encode_host_message(message: &HostMessage) -> Result<String, String> {
    match serialize_host_message(message) {
        Ok(payload) => Ok(payload),
        Err(error) => {
            if let HostMessage::Response { request_id, .. } = message {
                // Return a correlated error instead of disconnecting on a large snapshot.
                serialize_host_message(&HostMessage::Response {
                    request_id: request_id.clone(),
                    response: HostResponse::Error {
                        code: HostErrorCode::Internal,
                        message: error.to_string(),
                    },
                })
                .map_err(|error| error.to_string())
            } else {
                Err(error.to_string())
            }
        }
    }
}

async fn send_message<S>(sender: &mut S, message: Message, timeout: Duration) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    tokio::time::timeout(timeout, sender.send(message))
        .await
        .map_err(|_| "Fleet gateway write timed out.".to_string())?
        .map_err(|error| format!("Failed to send gateway message: {error}"))
}

fn permanent_upgrade_status(status: u16) -> bool {
    // A previous half-open connection can temporarily cause 409 after a network change.
    matches!(status, 401 | 403 | 404)
}

fn reconnect_backoff(previous: Duration, connected_for: Duration) -> Duration {
    if connected_for >= GATEWAY_IDLE_TIMEOUT {
        Duration::from_secs(1)
    } else {
        (previous * 2).min(Duration::from_secs(60))
    }
}

fn jittered_delay(base: Duration) -> Duration {
    let mut random = [0u8; 2];
    let _ = getrandom::fill(&mut random);
    // Spread reconnects across the second half of the backoff window.
    base / 2 + base.mul_f64(f64::from(u16::from_ne_bytes(random)) / f64::from(u16::MAX) / 2.0)
}

async fn wait_for_generation_change(state: &Arc<Mutex<FleetConnectionInner>>, generation: u64) {
    while is_current(state, generation) {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn gateway_url(manager_url: &str, instance_id: &str) -> Result<url::Url, String> {
    let mut url = validate_fleet_manager_url(manager_url)?;
    let gateway_scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(gateway_scheme)
        .map_err(|_| "Fleet Manager URL cannot be converted to a gateway URL.".to_string())?;
    url.set_path(&format!("/api/gateway/connect/{instance_id}"));
    Ok(url)
}

fn set_phase(
    state: &Arc<Mutex<FleetConnectionInner>>,
    generation: u64,
    phase: FleetConnectionPhase,
    error: Option<String>,
) {
    let Ok(mut inner) = state.lock() else {
        return;
    };
    if inner.generation != generation {
        return;
    }
    inner.phase = phase;
    inner.last_error = error;
}

fn is_current(state: &Arc<Mutex<FleetConnectionInner>>, generation: u64) -> bool {
    state
        .lock()
        .map(|inner| inner.generation == generation && inner.config.is_some())
        .unwrap_or(false)
}

async fn wait_for_reconnect(
    state: &Arc<Mutex<FleetConnectionInner>>,
    generation: u64,
    duration: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + duration;
    while tokio::time::Instant::now() < deadline {
        if !is_current(state, generation) {
            return false;
        }
        tokio::time::sleep(
            Duration::from_secs(1)
                .min(deadline.saturating_duration_since(tokio::time::Instant::now())),
        )
        .await;
    }
    is_current(state, generation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_snapshots_return_correlated_errors_without_dropping_the_connection() {
        let message = HostMessage::Response {
            request_id: "request-1".to_string(),
            response: HostResponse::ProductSnapshot {
                snapshot: serde_json::json!({
                    "content": "x".repeat(MAX_GATEWAY_MESSAGE_BYTES),
                }),
            },
        };
        let payload = encode_host_message(&message).expect("error response should fit");
        assert!(payload.len() < 1024);
        let response = machdoch_fleet_protocol::deserialize_host_message(&payload)
            .expect("valid gateway response");
        assert!(
            matches!(response, HostMessage::Response { request_id, response: HostResponse::Error { code: HostErrorCode::Internal, .. } } if request_id == "request-1")
        );
    }

    #[test]
    fn temporary_upgrade_failures_allow_reconnects() {
        for status in [409, 429, 500, 502, 503, 504] {
            assert!(!permanent_upgrade_status(status));
        }
        for status in [401, 403, 404] {
            assert!(permanent_upgrade_status(status));
        }
    }

    #[test]
    fn restart_close_allows_reconnects() {
        assert!(matches!(
            connection_result_from_close(Some(CloseFrame {
                code: CloseCode::Restart,
                reason: "Fleet Manager is restarting.".into(),
            })),
            ConnectionResult::Reconnect(_)
        ));
    }

    #[test]
    fn reconnect_backoff_is_bounded_and_resets_after_a_healthy_connection() {
        assert_eq!(
            reconnect_backoff(Duration::from_secs(60), Duration::from_secs(5)),
            Duration::from_secs(60)
        );
        assert_eq!(
            reconnect_backoff(Duration::from_secs(4), Duration::from_secs(5)),
            Duration::from_secs(8)
        );
        assert_eq!(
            reconnect_backoff(Duration::from_secs(60), Duration::from_secs(120)),
            Duration::from_secs(1)
        );
        for _ in 0..100 {
            let jitter = jittered_delay(Duration::from_secs(60));
            assert!(jitter >= Duration::from_secs(30) && jitter <= Duration::from_secs(60));
        }
    }

    #[tokio::test]
    async fn stalled_gateway_writes_have_a_deadline() {
        let mut sink = Box::pin(futures_util::sink::unfold(
            (),
            |(), _message: Message| async {
                std::future::pending::<Result<(), std::io::Error>>().await
            },
        ));
        let result = send_message(
            &mut sink,
            Message::Ping(Vec::new().into()),
            Duration::from_millis(10),
        )
        .await;
        assert_eq!(result.unwrap_err(), "Fleet gateway write timed out.");
    }

    #[tokio::test]
    async fn obsolete_generations_cancel_before_stalled_network_work() {
        let state = Arc::new(Mutex::new(FleetConnectionInner::default()));
        let completed = tokio::time::timeout(Duration::from_millis(100), async {
            tokio::select! {
                _ = wait_for_generation_change(&state, 1) => true,
                _ = std::future::pending::<()>() => false,
            }
        })
        .await;
        assert_eq!(completed, Ok(true));
    }

    #[test]
    fn gateway_url_is_wss_and_instance_scoped() {
        let url = gateway_url("https://fleet.example.test:8443", "instance_abc")
            .expect("gateway URL should build");

        assert_eq!(
            url.as_str(),
            "wss://fleet.example.test:8443/api/gateway/connect/instance_abc"
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn development_gateway_url_uses_ws_for_http_manager() {
        let url = gateway_url("http://127.0.0.1:43188", "instance_abc")
            .expect("development gateway URL should build");

        assert_eq!(
            url.as_str(),
            "ws://127.0.0.1:43188/api/gateway/connect/instance_abc"
        );
    }

    #[test]
    fn policy_close_stops_reconnects_and_preserves_the_reason() {
        let result = connection_result_from_close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: "Invalid hello message.".into(),
        }));

        match result {
            ConnectionResult::Stopped(error) => assert_eq!(
                error,
                "Fleet Manager rejected the connection: Invalid hello message."
            ),
            _ => panic!("policy close should stop reconnecting"),
        }
    }

    #[test]
    fn unsafe_close_reasons_are_not_exposed() {
        let result = connection_result_from_close(Some(CloseFrame {
            code: CloseCode::Policy,
            reason: "\u{1b}[31mspoofed".into(),
        }));

        match result {
            ConnectionResult::Stopped(error) => {
                assert_eq!(error, "Fleet Manager rejected the connection (1008).")
            }
            _ => panic!("policy close should stop reconnecting"),
        }
    }
}
