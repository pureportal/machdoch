use std::{
    future::Future,
    net::{IpAddr, SocketAddr},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use hickory_resolver::TokioResolver;

pub(super) struct HealthDnsResolver;

async fn lookup_addresses(host: &str) -> Result<Vec<SocketAddr>, String> {
    if let Ok(address) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(address, 0)]);
    }
    let resolver = TokioResolver::builder_tokio()
        .map_err(|error| format!("Unable to configure DNS resolution: {error}"))?
        .build()
        .map_err(|error| format!("Unable to initialize DNS resolution: {error}"))?;
    let lookup = resolver
        .lookup_ip(host)
        .await
        .map_err(|error| format!("Unable to resolve {host}: {error}"))?;
    Ok(lookup
        .iter()
        .map(|address| SocketAddr::new(address, 0))
        .collect())
}

impl reqwest::dns::Resolve for HealthDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let addresses = lookup_addresses(name.as_str())
                .await
                .map_err(std::io::Error::other)?;
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

pub(super) fn resolve_health_addresses(
    host: &str,
    port: u16,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<Vec<SocketAddr>, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Unable to start DNS resolution: {error}"))?;
    runtime
        .block_on(await_lookup(lookup_addresses(host), deadline, cancelled))
        .map(|addresses| {
            addresses
                .into_iter()
                .map(|address| SocketAddr::new(address.ip(), port))
                .collect()
        })
}

async fn await_lookup(
    lookup: impl Future<Output = Result<Vec<SocketAddr>, String>>,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<Vec<SocketAddr>, String> {
    tokio::pin!(lookup);
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("Health check was cancelled.".to_string());
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| "Health check timed out.".to_string())?;
        tokio::select! {
            result = &mut lookup => {
                if cancelled.load(Ordering::SeqCst) {
                    return Err("Health check was cancelled.".to_string());
                }
                if Instant::now() >= deadline {
                    return Err("Health check timed out.".to_string());
                }
                return result;
            }
            _ = tokio::time::sleep(remaining.min(Duration::from_millis(25))) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_drops_a_pending_dns_lookup() {
        let cancelled = AtomicBool::new(false);
        let lookup = async {
            cancelled.store(true, Ordering::SeqCst);
            std::future::pending().await
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let result = runtime.block_on(await_lookup(
            lookup,
            Instant::now() + Duration::from_secs(1),
            &cancelled,
        ));
        assert_eq!(result.unwrap_err(), "Health check was cancelled.");
    }

    #[test]
    fn a_pending_dns_lookup_cannot_outlive_its_deadline() {
        let cancelled = AtomicBool::new(false);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let result = runtime.block_on(await_lookup(
            std::future::pending(),
            Instant::now() + Duration::from_millis(1),
            &cancelled,
        ));
        assert_eq!(result.unwrap_err(), "Health check timed out.");
    }

    #[test]
    fn expired_resolution_does_not_start_a_lookup() {
        let result = resolve_health_addresses(
            "invalid.test",
            8080,
            Instant::now(),
            &AtomicBool::new(false),
        );
        assert_eq!(result.unwrap_err(), "Health check timed out.");
    }

    #[test]
    fn cancelled_resolution_does_not_start_a_lookup() {
        let result = resolve_health_addresses(
            "invalid.test",
            8080,
            Instant::now() + Duration::from_secs(1),
            &AtomicBool::new(true),
        );
        assert_eq!(result.unwrap_err(), "Health check was cancelled.");
    }

    #[test]
    fn ip_address_resolution_does_not_need_dns_configuration() {
        let result = resolve_health_addresses(
            "127.0.0.1",
            8080,
            Instant::now() + Duration::from_secs(1),
            &AtomicBool::new(false),
        );
        assert_eq!(
            result.unwrap(),
            vec!["127.0.0.1:8080".parse::<SocketAddr>().unwrap()]
        );
    }
}
