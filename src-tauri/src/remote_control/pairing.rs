use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    process::Command,
    sync::{atomic::AtomicBool, Arc},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use qrcode::{render::svg, QrCode};

use super::RemoteControlServerInfo;

struct PairingUrls {
    local_url: String,
    lan_url: Option<String>,
    display_url: String,
    qr_svg: String,
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(super) fn create_server_info(
    port: u16,
    token: String,
    started_at: u64,
    shutdown: Arc<AtomicBool>,
) -> Result<RemoteControlServerInfo, String> {
    let pairing_urls = create_pairing_urls(port, &token)?;
    let bind_address = format!("0.0.0.0:{port}");

    Ok(RemoteControlServerInfo {
        token,
        port,
        local_url: pairing_urls.local_url,
        lan_url: pairing_urls.lan_url,
        display_url: pairing_urls.display_url,
        qr_svg: pairing_urls.qr_svg,
        started_at,
        bind_address,
        shutdown,
    })
}

pub(super) fn refresh_server_pairing_url(
    server: &mut RemoteControlServerInfo,
    token: String,
) -> Result<(), String> {
    let pairing_urls = create_pairing_urls(server.port, &token)?;

    server.token = token;
    server.local_url = pairing_urls.local_url;
    server.lan_url = pairing_urls.lan_url;
    server.display_url = pairing_urls.display_url;
    server.qr_svg = pairing_urls.qr_svg;

    Ok(())
}

pub(super) fn open_url_in_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(url)
            .creation_flags(CREATE_NO_WINDOW);

        return command.spawn().map(|_| ()).map_err(|error| {
            format!("Mission Control could not be opened in your browser: {error}")
        });
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(url);

        return command.spawn().map(|_| ()).map_err(|error| {
            format!("Mission Control could not be opened in your browser: {error}")
        });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(url);

        return command.spawn().map(|_| ()).map_err(|error| {
            format!("Mission Control could not be opened in your browser: {error}")
        });
    }

    #[allow(unreachable_code)]
    Err("Opening Mission Control is not supported on this platform.".to_string())
}

pub(super) fn create_secure_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Unable to create a secure Mission Control token: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn create_pairing_urls(port: u16, token: &str) -> Result<PairingUrls, String> {
    let local_url = format!("http://127.0.0.1:{port}/#pair={token}");
    let lan_url = detect_lan_ip().map(|ip| format!("http://{ip}:{port}/#pair={token}"));
    let display_url = lan_url.clone().unwrap_or_else(|| local_url.clone());
    let qr_svg = create_qr_svg(&display_url)?;

    Ok(PairingUrls {
        local_url,
        lan_url,
        display_url,
        qr_svg,
    })
}

fn create_qr_svg(url: &str) -> Result<String, String> {
    let code = QrCode::new(url.as_bytes())
        .map_err(|error| format!("Unable to create Mission Control QR code: {error}"))?;

    Ok(code
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .dark_color(svg::Color("#0f172a"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

fn detect_lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))).ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();

    if ip.is_loopback() {
        return None;
    }

    Some(ip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn create_server_info_builds_pairing_urls_and_qr_svg() {
        let server = create_server_info(
            43187,
            "pair-token".to_string(),
            123,
            Arc::new(AtomicBool::new(false)),
        )
        .expect("server info should be created");

        assert_eq!(server.token, "pair-token");
        assert_eq!(server.port, 43187);
        assert_eq!(server.local_url, "http://127.0.0.1:43187/#pair=pair-token");
        assert_eq!(server.started_at, 123);
        assert_eq!(server.bind_address, "0.0.0.0:43187");
        assert!(server.display_url.ends_with(":43187/#pair=pair-token"));
        assert!(server.qr_svg.contains("<svg"));
    }

    #[test]
    fn refresh_server_pairing_url_rotates_token_and_urls() {
        let mut server = create_server_info(
            43187,
            "old-token".to_string(),
            123,
            Arc::new(AtomicBool::new(false)),
        )
        .expect("server info should be created");

        refresh_server_pairing_url(&mut server, "new-token".to_string())
            .expect("pairing URL should refresh");

        assert_eq!(server.token, "new-token");
        assert_eq!(server.local_url, "http://127.0.0.1:43187/#pair=new-token");
        assert!(server.display_url.ends_with(":43187/#pair=new-token"));
        assert!(server.qr_svg.contains("<svg"));
    }
}
