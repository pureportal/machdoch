use std::{
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
};

use super::model::{RunHealthCheck, RunHealthCheckKind};

pub fn check_health(check: &RunHealthCheck) -> Result<(), String> {
    match check.kind {
        RunHealthCheckKind::Tcp => check_tcp(check),
        RunHealthCheckKind::Http => check_http(check),
    }
}

fn check_tcp(check: &RunHealthCheck) -> Result<(), String> {
    let host = check
        .host
        .as_deref()
        .filter(|host| !host.trim().is_empty())
        .unwrap_or("127.0.0.1");
    let port = check
        .port
        .ok_or_else(|| "TCP health check needs a port.".to_string())?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Unable to resolve {host}:{port}: {error}"))?
        .collect::<Vec<SocketAddr>>();
    if addresses.is_empty() {
        return Err(format!("No address resolved for {host}:{port}."));
    }
    let timeout = Duration::from_millis(check.timeout_ms);
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "TCP connection to {host}:{port} failed: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "connection failed".to_string())
    ))
}

fn check_http(check: &RunHealthCheck) -> Result<(), String> {
    let url = check
        .url
        .as_deref()
        .ok_or_else(|| "HTTP health check needs a URL.".to_string())?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(check.timeout_ms))
        .build()
        .map_err(|error| format!("Unable to create the HTTP health client: {error}"))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("HTTP request to {url} failed: {error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "HTTP request to {url} returned {}.",
            response.status()
        ))
    }
}
