use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use mdns_sd::{
    DaemonEvent, IfKind, Receiver, ResolvedService, ServiceDaemon, ServiceEvent, ServiceInfo,
};
use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig as _};
use qrcode::{render::svg, QrCode};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::{net::TcpListener, time::timeout};

use super::{
    contract::{
        ManualEndpoint, ManualRendezvous, TransferNetworkInterface, PROTOCOL_MAJOR, PROTOCOL_MINOR,
    },
    protocol::{decode_sid, encode_sid, now_millis, random_array},
};

pub(crate) const SERVICE_TYPE: &str = "_machdoch-xfer._tcp.local.";
const SESSION_LABEL_PREFIX: &str = "Machdoch Transfer ";
const SESSION_LABEL_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MANUAL_CODE_PREFIX: &str = "machdoch-xfer:v1:";
const MDNS_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
// QrCode::new uses medium error correction. Keeping the complete manual code
// below this bound leaves margin under a version-40 byte-mode QR symbol while
// still carrying several multi-homed IPv4/IPv6 endpoints.
const MAX_MANUAL_CODE_BYTES: usize = 2_200;
const MAX_RENDEZVOUS_ENDPOINTS: usize = 16;
const MAX_MANUAL_CODE_LIFETIME_MILLIS: u64 = 15 * 60 * 1_000;
const MANUAL_CODE_CLOCK_SKEW_MILLIS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Clone)]
struct InterfaceAddress {
    ip: IpAddr,
    netmask: IpAddr,
}

#[derive(Debug, Clone)]
struct LanInterface {
    id: String,
    name: String,
    index: u32,
    recommended: bool,
    reason: Option<String>,
    addresses: Vec<InterfaceAddress>,
}

#[derive(Debug, Clone)]
pub(crate) struct NetworkSelection {
    interfaces: Vec<LanInterface>,
}

impl NetworkSelection {
    pub(crate) fn statuses(&self) -> Vec<TransferNetworkInterface> {
        self.interfaces
            .iter()
            .map(|interface| TransferNetworkInterface {
                id: interface.id.clone(),
                name: interface.name.clone(),
                addresses: interface
                    .addresses
                    .iter()
                    .map(|address| address.ip.to_string())
                    .collect(),
                selected: true,
                recommended: interface.recommended,
                reason: interface.reason.clone(),
            })
            .collect()
    }

    pub(crate) fn addresses(&self) -> Vec<IpAddr> {
        let mut addresses = self
            .interfaces
            .iter()
            .flat_map(|interface| interface.addresses.iter().map(|address| address.ip))
            .collect::<Vec<_>>();
        addresses.sort();
        addresses.dedup();
        addresses
    }

    pub(crate) fn interface_names(&self) -> Vec<String> {
        self.interfaces
            .iter()
            .map(|interface| interface.name.clone())
            .collect()
    }

    pub(crate) fn endpoints(&self, port: u16) -> Vec<ManualEndpoint> {
        let mut endpoints = self
            .interfaces
            .iter()
            .flat_map(|interface| {
                interface
                    .addresses
                    .iter()
                    .map(move |address| ManualEndpoint {
                        ip: address.ip.to_string(),
                        port,
                        // IPv6 zone indices have meaning only on the node
                        // that owns them. The receiver resolves a link-local
                        // endpoint onto its own matching interface.
                        scope_id: 0,
                    })
            })
            .collect::<Vec<_>>();
        endpoints.sort_by(|left, right| {
            left.ip
                .cmp(&right.ip)
                .then(left.scope_id.cmp(&right.scope_id))
        });
        endpoints.dedup();
        endpoints.truncate(MAX_RENDEZVOUS_ENDPOINTS);
        endpoints
    }

    pub(crate) fn connection_endpoints(&self, peer: SocketAddr) -> Vec<SocketAddr> {
        let peer_ip = normalize_ip(peer.ip());
        let (peer_scope, flow_info) = match peer {
            SocketAddr::V6(peer) => (peer.scope_id(), peer.flowinfo()),
            SocketAddr::V4(_) => (0, 0),
        };
        let mut endpoints = Vec::new();
        for interface in &self.interfaces {
            for address in &interface.addresses {
                let local_ip = normalize_ip(address.ip);
                if !same_prefix(peer_ip, local_ip, normalize_ip(address.netmask)) {
                    continue;
                }

                match (peer_ip, local_ip) {
                    (IpAddr::V4(ip), IpAddr::V4(_)) => {
                        endpoints.push(SocketAddr::new(IpAddr::V4(ip), peer.port()));
                    }
                    (IpAddr::V6(ip), IpAddr::V6(local))
                        if ip.is_unicast_link_local() || local.is_unicast_link_local() =>
                    {
                        if peer_scope == 0 || peer_scope == interface.index {
                            endpoints.push(SocketAddr::V6(SocketAddrV6::new(
                                ip,
                                peer.port(),
                                flow_info,
                                interface.index,
                            )));
                        }
                    }
                    (IpAddr::V6(ip), IpAddr::V6(_)) => {
                        endpoints.push(SocketAddr::V6(SocketAddrV6::new(
                            ip,
                            peer.port(),
                            flow_info,
                            0,
                        )));
                    }
                    _ => {}
                }
            }
        }
        endpoints.sort();
        endpoints.dedup();
        endpoints
    }

    pub(crate) fn contains_peer(&self, peer: SocketAddr) -> bool {
        !self.connection_endpoints(peer).is_empty()
    }
}

pub(crate) struct Advertisement {
    daemon: ServiceDaemon,
    fullname: String,
    pub(crate) monitor: Receiver<DaemonEvent>,
}

struct DaemonSetupGuard {
    daemon: ServiceDaemon,
    armed: bool,
}

impl DaemonSetupGuard {
    fn start() -> Result<Self, String> {
        ServiceDaemon::new()
            .map(|daemon| Self {
                daemon,
                armed: true,
            })
            .map_err(|_| "MDNS_START_FAILED".to_string())
    }

    fn daemon(&self) -> &ServiceDaemon {
        &self.daemon
    }

    fn finish(mut self) -> ServiceDaemon {
        self.armed = false;
        self.daemon.clone()
    }
}

impl Drop for DaemonSetupGuard {
    fn drop(&mut self) {
        if self.armed {
            // Setup failed before an async owner existed. Queue a graceful
            // shutdown so the crate's daemon thread cannot outlive the
            // failed transfer attempt.
            let _ = self.daemon.shutdown();
        }
    }
}

impl Advertisement {
    pub(crate) async fn shutdown(self) {
        if let Ok(status) = self.daemon.unregister(&self.fullname) {
            let _ = timeout(MDNS_SHUTDOWN_TIMEOUT, status.recv_async()).await;
        }
        if let Ok(status) = self.daemon.shutdown() {
            let _ = timeout(MDNS_SHUTDOWN_TIMEOUT, status.recv_async()).await;
        }
    }
}

pub(crate) struct Browser {
    daemon: ServiceDaemon,
    pub(crate) events: Receiver<ServiceEvent>,
    pub(crate) monitor: Receiver<DaemonEvent>,
}

impl Browser {
    pub(crate) async fn shutdown(self) {
        let _ = self.daemon.stop_browse(SERVICE_TYPE);
        if let Ok(status) = self.daemon.shutdown() {
            let _ = timeout(MDNS_SHUTDOWN_TIMEOUT, status.recv_async()).await;
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedRendezvous {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) sid: [u8; 16],
    pub(crate) endpoints: Vec<SocketAddr>,
    pub(crate) expires_at: u64,
}

fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ipv6) => ipv6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ipv6)),
        value => value,
    }
}

fn same_prefix(peer: IpAddr, local: IpAddr, netmask: IpAddr) -> bool {
    match (peer, local, netmask) {
        (IpAddr::V4(peer), IpAddr::V4(local), IpAddr::V4(mask)) => {
            u32::from(peer) & u32::from(mask) == u32::from(local) & u32::from(mask)
        }
        (IpAddr::V6(peer), IpAddr::V6(local), IpAddr::V6(mask)) => {
            u128::from(peer) & u128::from(mask) == u128::from(local) & u128::from(mask)
        }
        _ => false,
    }
}

fn is_usable_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast(),
        IpAddr::V6(ip) => !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast(),
    }
}

fn looks_like_tunnel(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "docker",
        "veth",
        "vmnet",
        "vmware",
        "virtualbox",
        "tailscale",
        "zerotier",
        "wireguard",
        "nordlynx",
        "openvpn",
        "hamachi",
        "vpn",
        "wintun",
        "tunnel",
        "loopback",
        "hyper-v",
        "vethernet",
        "virbr",
        "podman",
        "flannel",
    ]
    .iter()
    .any(|marker| name.contains(marker))
        || name == "tun"
        || name == "tap"
        || name.starts_with("tun")
        || name.starts_with("tap")
        || name.starts_with("utun")
        || name.starts_with("wg")
        || name.starts_with("ppp")
        || name.starts_with("ipsec")
        || name.starts_with("br-")
        || name.starts_with("cni")
}

fn random_token(length: usize, alphabet: &[u8]) -> Result<String, String> {
    if alphabet.is_empty() || alphabet.len() > 128 || length > 64 {
        return Err("SECURE_RANDOM_UNAVAILABLE".to_string());
    }
    let acceptance_limit = (256 / alphabet.len()) * alphabet.len();
    let mut output = String::with_capacity(length);
    while output.len() < length {
        let random: [u8; 32] = random_array()?;
        for byte in random {
            if usize::from(byte) < acceptance_limit {
                output.push(char::from(alphabet[usize::from(byte) % alphabet.len()]));
                if output.len() == length {
                    break;
                }
            }
        }
    }
    Ok(output)
}

fn enumerate_interfaces() -> Result<Vec<LanInterface>, String> {
    let mut grouped = BTreeMap::<(u32, String), LanInterface>::new();
    for interface in
        NetworkInterface::show().map_err(|_| "LOCAL_NETWORK_ENUMERATION_FAILED".to_string())?
    {
        if interface.internal {
            continue;
        }
        let tunnel = looks_like_tunnel(&interface.name);
        let key = (interface.index, interface.name.clone());
        let entry = grouped.entry(key).or_insert_with(|| LanInterface {
            id: format!("{}:{}", interface.index, interface.name),
            name: interface.name.clone(),
            index: interface.index,
            recommended: !tunnel,
            reason: tunnel.then(|| {
                "Virtual or tunnel interface; select only when both PCs use it.".to_string()
            }),
            addresses: Vec::new(),
        });
        for address in interface.addr {
            let (ip, netmask) = match address {
                Addr::V4(value) => (
                    IpAddr::V4(value.ip),
                    IpAddr::V4(value.netmask.unwrap_or(Ipv4Addr::BROADCAST)),
                ),
                Addr::V6(value) => (
                    IpAddr::V6(value.ip),
                    IpAddr::V6(value.netmask.unwrap_or(Ipv6Addr::from(u128::MAX))),
                ),
            };
            if is_usable_ip(ip) {
                entry.addresses.push(InterfaceAddress { ip, netmask });
            }
        }
    }
    let mut interfaces = grouped
        .into_values()
        .filter(|interface| !interface.addresses.is_empty())
        .collect::<Vec<_>>();
    interfaces.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.index.cmp(&right.index))
    });
    Ok(interfaces)
}

pub(crate) fn inspect_network_interfaces() -> Result<Vec<TransferNetworkInterface>, String> {
    let interfaces = enumerate_interfaces()?;
    let has_recommended = interfaces.iter().any(|interface| interface.recommended);
    Ok(interfaces
        .into_iter()
        .map(|interface| TransferNetworkInterface {
            id: interface.id,
            name: interface.name,
            addresses: interface
                .addresses
                .iter()
                .map(|address| address.ip.to_string())
                .collect(),
            selected: interface.recommended || !has_recommended,
            recommended: interface.recommended,
            reason: interface.reason,
        })
        .collect())
}

pub(crate) fn select_network_interfaces(
    requested: &BTreeSet<String>,
) -> Result<NetworkSelection, String> {
    let interfaces = enumerate_interfaces()?;
    let available = interfaces
        .iter()
        .map(|interface| interface.id.clone())
        .collect::<BTreeSet<_>>();
    if !requested.is_empty() && !requested.is_subset(&available) {
        return Err("NETWORK_INTERFACE_CHANGED".to_string());
    }
    let has_recommended = interfaces.iter().any(|interface| interface.recommended);
    let selected = interfaces
        .into_iter()
        .filter(|interface| {
            if requested.is_empty() {
                interface.recommended || !has_recommended
            } else {
                requested.contains(&interface.id)
            }
        })
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err("NO_NETWORK_INTERFACE_SELECTED".to_string());
    }
    Ok(NetworkSelection {
        interfaces: selected,
    })
}

pub(crate) fn bind_listener() -> Result<TcpListener, String> {
    let dual_stack = (|| -> std::io::Result<std::net::TcpListener> {
        let socket = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
        socket.set_only_v6(false)?;
        socket.set_nonblocking(true)?;
        socket.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)).into())?;
        socket.listen(16)?;
        Ok(socket.into())
    })();
    let listener = match dual_stack {
        Ok(listener) => listener,
        Err(_) => {
            let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))
                .map_err(|_| "NETWORK_LISTENER_FAILED".to_string())?;
            socket
                .set_nonblocking(true)
                .map_err(|_| "NETWORK_LISTENER_FAILED".to_string())?;
            socket
                .bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())
                .map_err(|_| "NETWORK_LISTENER_FAILED".to_string())?;
            socket
                .listen(16)
                .map_err(|_| "NETWORK_LISTENER_FAILED".to_string())?;
            socket.into()
        }
    };
    TcpListener::from_std(listener).map_err(|_| "NETWORK_LISTENER_FAILED".to_string())
}

fn configure_daemon(daemon: &ServiceDaemon, selection: &NetworkSelection) -> Result<(), String> {
    daemon
        .disable_interface(IfKind::All)
        .map_err(|_| "MDNS_INTERFACE_SETUP_FAILED".to_string())?;
    daemon
        .enable_interface(
            selection
                .interface_names()
                .into_iter()
                .map(IfKind::Name)
                .collect::<Vec<_>>(),
        )
        .map_err(|_| "MDNS_INTERFACE_SETUP_FAILED".to_string())?;
    Ok(())
}

pub(crate) fn random_session_label() -> Result<String, String> {
    let suffix = random_token(4, SESSION_LABEL_ALPHABET)?;
    Ok(format!("{SESSION_LABEL_PREFIX}{suffix}"))
}

pub(crate) fn is_valid_session_label(label: &str) -> bool {
    label
        .strip_prefix(SESSION_LABEL_PREFIX)
        .is_some_and(|suffix| {
            suffix.len() == 4
                && suffix
                    .bytes()
                    .all(|byte| SESSION_LABEL_ALPHABET.contains(&byte))
        })
}

pub(crate) fn start_advertisement(
    selection: &NetworkSelection,
    label: &str,
    sid: &[u8; 16],
    port: u16,
) -> Result<Advertisement, String> {
    let daemon = DaemonSetupGuard::start()?;
    configure_daemon(daemon.daemon(), selection)?;
    let monitor = daemon
        .daemon()
        .monitor()
        .map_err(|_| "MDNS_MONITOR_FAILED".to_string())?;
    let hostname = format!(
        "machdoch-{}.local.",
        random_token(18, b"abcdefghijklmnopqrstuvwxyz0123456789")?
    );
    let properties = HashMap::from([
        ("txtvers".to_string(), "1".to_string()),
        (
            "protovers".to_string(),
            format!("{PROTOCOL_MAJOR}.{PROTOCOL_MINOR}"),
        ),
        ("sid".to_string(), encode_sid(sid)),
    ]);
    let mut service = ServiceInfo::new(
        SERVICE_TYPE,
        label,
        &hostname,
        selection.addresses().as_slice(),
        port,
        properties,
    )
    .map_err(|_| "MDNS_SERVICE_INVALID".to_string())?;
    service.set_interfaces(
        selection
            .interface_names()
            .into_iter()
            .map(IfKind::Name)
            .collect(),
    );
    let fullname = service.get_fullname().to_string();
    daemon
        .daemon()
        .register(service)
        .map_err(|_| "MDNS_REGISTER_FAILED".to_string())?;
    Ok(Advertisement {
        daemon: daemon.finish(),
        fullname,
        monitor,
    })
}

pub(crate) fn start_browser(selection: &NetworkSelection) -> Result<Browser, String> {
    let daemon = DaemonSetupGuard::start()?;
    configure_daemon(daemon.daemon(), selection)?;
    let monitor = daemon
        .daemon()
        .monitor()
        .map_err(|_| "MDNS_MONITOR_FAILED".to_string())?;
    let events = daemon
        .daemon()
        .browse(SERVICE_TYPE)
        .map_err(|_| "MDNS_BROWSE_FAILED".to_string())?;
    Ok(Browser {
        daemon: daemon.finish(),
        events,
        monitor,
    })
}

fn label_from_fullname(fullname: &str) -> Option<String> {
    let suffix = format!(".{SERVICE_TYPE}");
    fullname
        .strip_suffix(&suffix)
        .map(|label| label.replace("\\032", " ").replace("\\046", "."))
        .filter(|label| is_valid_session_label(label))
}

pub(crate) fn parse_resolved_service(service: &ResolvedService) -> Option<ResolvedRendezvous> {
    if !service.is_valid()
        || service.get_properties().iter().count() != 3
        || service.get_property_val_str("txtvers") != Some("1")
        || service.get_property_val_str("protovers")
            != Some(format!("{PROTOCOL_MAJOR}.{PROTOCOL_MINOR}").as_str())
    {
        return None;
    }
    let sid = decode_sid(service.get_property_val_str("sid")?).ok()?;
    let label = label_from_fullname(service.get_fullname())?;
    let mut endpoints = service
        .get_addresses()
        .iter()
        .filter_map(|address| match address {
            mdns_sd::ScopedIp::V4(value) if is_usable_ip(IpAddr::V4(*value.addr())) => Some(
                SocketAddr::new(IpAddr::V4(*value.addr()), service.get_port()),
            ),
            mdns_sd::ScopedIp::V6(value) if is_usable_ip(IpAddr::V6(*value.addr())) => {
                Some(SocketAddr::V6(SocketAddrV6::new(
                    *value.addr(),
                    service.get_port(),
                    0,
                    value.scope_id().index,
                )))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    endpoints.sort();
    endpoints.dedup();
    endpoints.truncate(MAX_RENDEZVOUS_ENDPOINTS);
    if endpoints.is_empty() {
        return None;
    }
    Some(ResolvedRendezvous {
        id: service.get_fullname().to_string(),
        label,
        sid,
        endpoints,
        expires_at: now_millis().saturating_add(10 * 60 * 1_000),
    })
}

pub(crate) fn manual_rendezvous(
    selection: &NetworkSelection,
    label: &str,
    sid: &[u8; 16],
    port: u16,
    expires_at: u64,
) -> ManualRendezvous {
    ManualRendezvous {
        protocol_version: PROTOCOL_MAJOR,
        session_label: label.to_string(),
        sid: encode_sid(sid),
        endpoints: selection.endpoints(port),
        expires_at,
    }
}

pub(crate) fn encode_manual_code(value: &ManualRendezvous) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "MANUAL_CODE_FAILED".to_string())?;
    let code = format!("{MANUAL_CODE_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes));
    if code.len() > MAX_MANUAL_CODE_BYTES {
        return Err("MANUAL_CODE_FAILED".to_string());
    }
    Ok(code)
}

pub(crate) fn decode_manual_code(value: &str) -> Result<ResolvedRendezvous, String> {
    let value = value.trim();
    if value.len() > MAX_MANUAL_CODE_BYTES {
        return Err("INVALID_MANUAL_CODE".to_string());
    }
    let encoded = value
        .strip_prefix(MANUAL_CODE_PREFIX)
        .ok_or_else(|| "INVALID_MANUAL_CODE".to_string())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "INVALID_MANUAL_CODE".to_string())?;
    let rendezvous = serde_json::from_slice::<ManualRendezvous>(&bytes)
        .map_err(|_| "INVALID_MANUAL_CODE".to_string())?;
    let now = now_millis();
    if rendezvous.protocol_version != PROTOCOL_MAJOR
        || !is_valid_session_label(&rendezvous.session_label)
        || now
            > rendezvous
                .expires_at
                .saturating_add(MANUAL_CODE_CLOCK_SKEW_MILLIS)
        || rendezvous.expires_at > now.saturating_add(MAX_MANUAL_CODE_LIFETIME_MILLIS)
        || rendezvous.endpoints.is_empty()
        || rendezvous.endpoints.len() > MAX_RENDEZVOUS_ENDPOINTS
    {
        return Err("INVALID_MANUAL_CODE".to_string());
    }
    let sid = decode_sid(&rendezvous.sid).map_err(|_| "INVALID_MANUAL_CODE".to_string())?;
    let mut endpoints = rendezvous
        .endpoints
        .into_iter()
        .map(|endpoint| {
            let ip = endpoint
                .ip
                .parse::<IpAddr>()
                .map_err(|_| "INVALID_MANUAL_CODE".to_string())?;
            if !is_usable_ip(ip)
                || endpoint.port == 0
                || match ip {
                    IpAddr::V4(_) => endpoint.scope_id != 0,
                    IpAddr::V6(ip) => !ip.is_unicast_link_local() && endpoint.scope_id != 0,
                }
            {
                return Err("INVALID_MANUAL_CODE".to_string());
            }
            Ok(match ip {
                IpAddr::V4(ip) => SocketAddr::from((ip, endpoint.port)),
                // A sender's link-local zone index is never meaningful on
                // this machine. Canonicalize it and let NetworkSelection map
                // the address to a matching local interface before connect.
                IpAddr::V6(ip) => SocketAddr::V6(SocketAddrV6::new(ip, endpoint.port, 0, 0)),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    endpoints.sort();
    endpoints.dedup();
    Ok(ResolvedRendezvous {
        id: format!("manual:{}", encode_sid(&sid)),
        label: rendezvous.session_label,
        sid,
        endpoints,
        expires_at: rendezvous.expires_at,
    })
}

pub(crate) fn create_qr_svg(value: &str) -> Result<String, String> {
    let code = QrCode::new(value.as_bytes()).map_err(|_| "QR_CODE_FAILED".to_string())?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(240, 240)
        .dark_color(svg::Color("#0f172a"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_validation_accepts_direct_peers_and_rejects_routed_peers() {
        assert!(same_prefix(
            "192.168.20.45".parse().unwrap(),
            "192.168.20.3".parse().unwrap(),
            "255.255.255.0".parse().unwrap()
        ));
        assert!(!same_prefix(
            "192.168.21.45".parse().unwrap(),
            "192.168.20.3".parse().unwrap(),
            "255.255.255.0".parse().unwrap()
        ));
        assert!(same_prefix(
            "fe80::42".parse().unwrap(),
            "fe80::12".parse().unwrap(),
            "ffff:ffff:ffff:ffff::".parse().unwrap()
        ));
    }

    #[test]
    fn manual_code_round_trip_is_bounded_and_rejects_expiry() {
        let value = ManualRendezvous {
            protocol_version: PROTOCOL_MAJOR,
            session_label: "Machdoch Transfer TEST".to_string(),
            sid: encode_sid(&[7; 16]),
            endpoints: vec![ManualEndpoint {
                ip: "192.168.1.10".to_string(),
                port: 42_000,
                scope_id: 0,
            }],
            expires_at: now_millis() + 60_000,
        };
        let encoded = encode_manual_code(&value).expect("manual code should encode");
        let decoded = decode_manual_code(&encoded).expect("manual code should decode");
        assert_eq!(decoded.label, value.session_label);
        assert_eq!(decoded.sid, [7; 16]);
        assert_eq!(decoded.endpoints.len(), 1);

        let mut skewed = value.clone();
        skewed.expires_at = now_millis()
            .saturating_sub(MANUAL_CODE_CLOCK_SKEW_MILLIS)
            .saturating_add(60_000);
        assert!(decode_manual_code(&encode_manual_code(&skewed).unwrap()).is_ok());

        let mut expired = value;
        expired.expires_at = now_millis()
            .saturating_sub(MANUAL_CODE_CLOCK_SKEW_MILLIS)
            .saturating_sub(1);
        assert!(decode_manual_code(&encode_manual_code(&expired).unwrap()).is_err());
    }

    #[test]
    fn manual_codes_bound_multi_address_sessions_and_always_fit_a_qr_code() {
        let addresses = (1..=32)
            .map(|suffix| InterfaceAddress {
                ip: IpAddr::V6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, suffix)),
                netmask: IpAddr::V6(Ipv6Addr::new(
                    u16::MAX,
                    u16::MAX,
                    u16::MAX,
                    u16::MAX,
                    0,
                    0,
                    0,
                    0,
                )),
            })
            .collect();
        let selection = NetworkSelection {
            interfaces: vec![LanInterface {
                id: "7:ethernet".to_string(),
                name: "ethernet".to_string(),
                index: 7,
                recommended: true,
                reason: None,
                addresses,
            }],
        };
        let rendezvous = manual_rendezvous(
            &selection,
            "Machdoch Transfer TEST",
            &[7; 16],
            42_000,
            now_millis() + 60_000,
        );

        assert_eq!(rendezvous.endpoints.len(), MAX_RENDEZVOUS_ENDPOINTS);
        let code = encode_manual_code(&rendezvous).expect("bounded manual code should encode");
        assert!(code.len() <= MAX_MANUAL_CODE_BYTES);
        create_qr_svg(&code).expect("every generated manual code should fit its QR fallback");
    }

    #[test]
    fn link_local_endpoints_use_the_receivers_interface_index() {
        let selection = NetworkSelection {
            interfaces: vec![LanInterface {
                id: "7:ethernet".to_string(),
                name: "ethernet".to_string(),
                index: 7,
                recommended: true,
                reason: None,
                addresses: vec![InterfaceAddress {
                    ip: "fe80::12".parse().expect("local IPv6 address"),
                    netmask: "ffff:ffff:ffff:ffff::".parse().expect("IPv6 netmask"),
                }],
            }],
        };
        let portable = SocketAddr::V6(SocketAddrV6::new(
            "fe80::42".parse().expect("peer IPv6 address"),
            42_000,
            0,
            0,
        ));
        let endpoints = selection.connection_endpoints(portable);
        assert_eq!(endpoints.len(), 1);
        assert_eq!(
            endpoints[0],
            SocketAddr::V6(SocketAddrV6::new(
                "fe80::42".parse().expect("peer IPv6 address"),
                42_000,
                0,
                7,
            ))
        );

        let foreign_scope = SocketAddr::V6(SocketAddrV6::new(
            "fe80::42".parse().expect("peer IPv6 address"),
            42_000,
            0,
            9,
        ));
        assert!(selection.connection_endpoints(foreign_scope).is_empty());
    }

    #[test]
    fn manual_codes_never_trust_a_remote_ipv6_zone_index() {
        let mut value = ManualRendezvous {
            protocol_version: PROTOCOL_MAJOR,
            session_label: "Machdoch Transfer TEST".to_string(),
            sid: encode_sid(&[7; 16]),
            endpoints: vec![ManualEndpoint {
                ip: "fe80::42".to_string(),
                port: 42_000,
                scope_id: 999,
            }],
            expires_at: now_millis() + 60_000,
        };
        let decoded = decode_manual_code(&encode_manual_code(&value).expect("manual code"))
            .expect("link-local scope should be canonicalized");
        assert_eq!(decoded.endpoints[0].to_string(), "[fe80::42]:42000");

        value.endpoints[0].ip = "fd00::42".to_string();
        assert!(decode_manual_code(&encode_manual_code(&value).expect("manual code")).is_err());
    }

    #[test]
    fn rendezvous_labels_use_the_exact_spoof_resistant_shape() {
        for valid in ["Machdoch Transfer TEST", "Machdoch Transfer 2345"] {
            assert!(is_valid_session_label(valid));
        }
        for invalid in [
            "Machdoch Transfer O0I1",
            "Machdoch Transfer TEST ",
            "Machdoch Transfer \u{202e}TSET",
            "Trusted PC",
        ] {
            assert!(!is_valid_session_label(invalid), "{invalid} should fail");
        }
    }

    #[test]
    fn common_cross_platform_tunnel_interfaces_are_not_recommended() {
        for name in [
            "utun4",
            "wg0",
            "ppp0",
            "NordLynx",
            "OpenVPN TAP-Windows6",
            "virbr0",
            "br-deadbeef",
            "cni0",
        ] {
            assert!(
                looks_like_tunnel(name),
                "{name} should be treated as a tunnel"
            );
        }
        for name in ["en0", "eth0", "wlan0", "Ethernet", "Wi-Fi"] {
            assert!(!looks_like_tunnel(name), "{name} should remain recommended");
        }
    }
}
