use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use machdoch_fleet_protocol::{
    serialize_host_message, HostMessage, ManagerMessage, GATEWAY_PROTOCOL_VERSION,
    MAX_GATEWAY_MESSAGE_BYTES, PRODUCT_CAPABILITY,
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
        match connect_once(&app_handle, &state, &config, generation).await {
            ConnectionResult::Reset => return,
            ConnectionResult::Stopped(error) => {
                set_phase(&state, generation, FleetConnectionPhase::Error, Some(error));
                return;
            }
            ConnectionResult::Reconnect(error) => {
                set_phase(&state, generation, FleetConnectionPhase::Error, Some(error));
            }
        }
        if !wait_for_reconnect(&state, generation, reconnect_delay).await {
            return;
        }
        reconnect_delay = (reconnect_delay * 2).min(Duration::from_secs(60));
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
            if matches!(response.status().as_u16(), 401 | 403 | 404 | 409) =>
        {
            return ConnectionResult::Stopped(match response.status().as_u16() {
                409 => "Fleet Manager rejected a duplicate instance connection.".to_string(),
                _ => "Fleet Manager rejected the instance credentials.".to_string(),
            });
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
    let mut generation_check = tokio::time::interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if send_host_message(&mut sender, &HostMessage::Heartbeat { sent_at: now_seconds() }).await.is_err() {
                    return ConnectionResult::Reconnect("Fleet gateway connection closed.".to_string());
                }
            }
            _ = generation_check.tick() => {
                if !is_current(state, generation) {
                    let _ = sender.close().await;
                    return ConnectionResult::Reset;
                }
            }
            inbound = receiver.next() => {
                match inbound {
                    Some(Ok(Message::Text(payload))) => {
                        if payload.len() > MAX_GATEWAY_MESSAGE_BYTES {
                            return ConnectionResult::Stopped("Fleet gateway message exceeded the configured limit.".to_string());
                        }
                        match serde_json::from_str::<ManagerMessage>(&payload) {
                            Ok(ManagerMessage::Request { request_id, request }) => {
                                let response = crate::fleet_control::handle_fleet_request(app_handle, request);
                                if send_host_message(&mut sender, &HostMessage::Response { request_id, response }).await.is_err() {
                                    return ConnectionResult::Reconnect("Fleet gateway connection closed.".to_string());
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
                        if sender.send(Message::Pong(payload)).await.is_err() {
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
    let payload = serialize_host_message(message).map_err(|error| error.to_string())?;
    sender
        .send(Message::Text(payload.into()))
        .await
        .map_err(|error| format!("Failed to send gateway message: {error}"))
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
