use std::{
    net::{IpAddr, Ipv4Addr},
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tauri::Manager;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message,
    },
    MaybeTlsStream, WebSocketStream,
};

use super::{config::validate_fleet_manager_url, FleetConnectionPhase, FleetConnectionState};
use crate::workspace_run::{
    model::{RunConfiguration, RunLifecycleState},
    WorkspaceRunState,
};

const IO_TIMEOUT: Duration = Duration::from_secs(10);
static ACTIVE_TUNNELS: AtomicUsize = AtomicUsize::new(0);

struct TunnelPermit;

impl Drop for TunnelPermit {
    fn drop(&mut self) {
        ACTIVE_TUNNELS.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewTarget {
    pub(crate) workspace: String,
    configuration_id: String,
    port: u16,
}

struct RunningTarget {
    address: IpAddr,
    pid: u32,
    started_at: Option<u64>,
}

fn running_target(app: &tauri::AppHandle, target: &PreviewTarget) -> Result<RunningTarget, String> {
    if target.workspace.is_empty()
        || target.workspace.len() > 12000
        || target.configuration_id.is_empty()
        || target.configuration_id.len() > 64
        || target.port < 1024
    {
        return Err("Invalid preview target.".into());
    }
    let snapshot = app
        .state::<WorkspaceRunState>()
        .manager()
        .snapshot(&target.workspace)?;
    let status = snapshot
        .configurations
        .iter()
        .find(|status| status.configuration.id() == target.configuration_id)
        .ok_or("Choose a run configuration on this device.")?;
    let RunConfiguration::Task { ports, urls, .. } = &status.configuration else {
        return Err("Choose a task configuration for the preview.".into());
    };
    if !ports.contains(&target.port)
        || !matches!(
            status.state,
            RunLifecycleState::Running | RunLifecycleState::Unhealthy
        )
    {
        return Err("Start the selected service before opening its preview.".into());
    }
    let pid = status.pid.ok_or("The preview service is not running.")?;
    let address = urls
        .iter()
        .filter_map(|value| url::Url::parse(value).ok())
        .find(|url| {
            url.port_or_known_default() == Some(target.port)
                && matches!(
                    url.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                )
        })
        .map(|url| {
            if matches!(url.host_str(), Some("[::1]" | "::1")) {
                IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
            } else {
                IpAddr::V4(Ipv4Addr::LOCALHOST)
            }
        })
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    Ok(RunningTarget {
        address,
        pid,
        started_at: status.started_at,
    })
}

pub(crate) fn validate(app: &tauri::AppHandle, value: Value) -> Result<PreviewTarget, String> {
    let target: PreviewTarget =
        serde_json::from_value(value).map_err(|_| "Invalid preview target.")?;
    running_target(app, &target)?;
    Ok(target)
}

pub(crate) async fn open(
    app: tauri::AppHandle,
    target: PreviewTarget,
    tunnel_id: String,
    token: String,
) -> Result<(), String> {
    if !machdoch_fleet_protocol::identifiers::valid_uuid(&tunnel_id)
        || token.len() != 64
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Invalid preview credential.".into());
    }
    ACTIVE_TUNNELS
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
            (count < 32).then_some(count + 1)
        })
        .map_err(|_| "Close an existing preview connection before opening another.")?;
    let permit = TunnelPermit;
    let running = running_target(&app, &target)?;
    let (config, generation) = {
        let state = app.state::<FleetConnectionState>();
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Fleet connection is unavailable.")?;
        if inner.phase != FleetConnectionPhase::Connected {
            return Err("Connect to Fleet Manager before opening a preview.".into());
        }
        (
            inner
                .config
                .clone()
                .ok_or("Fleet connection is unavailable.")?,
            inner.generation,
        )
    };
    let mut url = validate_fleet_manager_url(&config.manager_url)?;
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| "Invalid preview URL.")?;
    url.set_path(&format!("/api/gateway/preview/{tunnel_id}"));
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid preview URL.")?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "Invalid preview credential.")?,
    );
    let mut websocket_config = WebSocketConfig::default();
    websocket_config.max_message_size = Some(1024 * 1024);
    websocket_config.max_frame_size = Some(1024 * 1024);
    let (tcp, (socket, _)) = tokio::time::timeout(IO_TIMEOUT, async {
        tokio::try_join!(
            async {
                TcpStream::connect((running.address, target.port))
                    .await
                    .map_err(|_| {
                        "The service is not listening. Check its port and retry Preview."
                            .to_string()
                    })
            },
            async {
                connect_async_with_config(request, Some(websocket_config), false)
                    .await
                    .map_err(|_| {
                        "Fleet Manager rejected the preview connection. Reopen the preview."
                            .to_string()
                    })
            }
        )
    })
    .await
    .map_err(|_| "The preview connection timed out. Retry Preview.")??;
    if !is_current(&app, generation, &target, &running) {
        return Err("The preview service stopped. Reopen the preview.".into());
    }
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        if let Err(error) = relay(app, generation, target, running, tcp, socket).await {
            eprintln!("Fleet preview closed: {error}");
        }
    });
    Ok(())
}

fn is_current(
    app: &tauri::AppHandle,
    generation: u64,
    target: &PreviewTarget,
    running: &RunningTarget,
) -> bool {
    let state = app.state::<FleetConnectionState>();
    let connected = state.inner.lock().is_ok_and(|inner| {
        inner.generation == generation && inner.phase == FleetConnectionPhase::Connected
    });
    connected
        && running_target(app, target).is_ok_and(|current| {
            current.pid == running.pid && current.started_at == running.started_at
        })
}

async fn relay(
    app: tauri::AppHandle,
    generation: u64,
    target: PreviewTarget,
    running: RunningTarget,
    mut tcp: TcpStream,
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
) -> Result<(), String> {
    let (mut sender, mut receiver) = socket.split();
    let mut buffer = [0u8; 64 * 1024];
    let mut monitor = tokio::time::interval(Duration::from_secs(1));
    monitor.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let deadline = tokio::time::sleep(Duration::from_secs(3600));
    tokio::pin!(deadline);
    let mut alive = true;
    loop {
        tokio::select! {
            _ = &mut deadline => return Ok(()),
            _ = monitor.tick() => if !is_current(&app, generation, &target, &running) { return Ok(()); },
            _ = heartbeat.tick() => {
                if !alive { return Err("Preview connection is unresponsive.".into()); }
                alive = false;
                tokio::time::timeout(IO_TIMEOUT, sender.send(Message::Ping(Vec::new().into()))).await.map_err(|_| "Preview write timed out.")?.map_err(|_| "Preview connection closed.")?;
            },
            result = tcp.read(&mut buffer) => {
                let count = result.map_err(|_| "Preview service connection closed.")?;
                if count == 0 { return Ok(()); }
                tokio::time::timeout(IO_TIMEOUT, sender.send(Message::Binary(buffer[..count].to_vec().into()))).await.map_err(|_| "Preview write timed out.")?.map_err(|_| "Preview connection closed.")?;
            },
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    tokio::time::timeout(IO_TIMEOUT, tcp.write_all(&bytes)).await.map_err(|_| "Preview service write timed out.")?.map_err(|_| "Preview service connection closed.")?;
                },
                Some(Ok(Message::Ping(bytes))) => {
                    tokio::time::timeout(IO_TIMEOUT, sender.send(Message::Pong(bytes))).await.map_err(|_| "Preview write timed out.")?.map_err(|_| "Preview connection closed.")?;
                },
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                _ => return Err("Invalid preview tunnel message.".into()),
            }
        }
    }
}
