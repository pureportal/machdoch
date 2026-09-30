use std::{
    net::{SocketAddr, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, TryRecvError},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use super::{
    health_dns::{resolve_health_addresses, HealthDnsResolver},
    model::{RunHealthCheck, RunHealthCheckKind},
};

const MAX_CONCURRENT_HEALTH_PROBES: usize = 4;

struct HealthProbeAdmission {
    active: Mutex<usize>,
    limit: usize,
}

struct HealthProbePermit {
    admission: Arc<HealthProbeAdmission>,
}

pub struct HealthProbe {
    receiver: Receiver<Result<(), String>>,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}

#[derive(Debug)]
pub enum HealthProbeStartError {
    CapacityExhausted,
    WorkerStart(String),
}

impl std::fmt::Display for HealthProbeStartError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CapacityExhausted => formatter.write_str("Health check capacity is exhausted."),
            Self::WorkerStart(error) => formatter.write_str(error),
        }
    }
}

impl HealthProbeAdmission {
    fn new(limit: usize) -> Self {
        Self {
            active: Mutex::new(0),
            limit,
        }
    }

    fn acquire(self: &Arc<Self>) -> Option<HealthProbePermit> {
        let mut active = self.active.lock().ok()?;
        if *active >= self.limit {
            return None;
        }
        *active += 1;
        Some(HealthProbePermit {
            admission: Arc::clone(self),
        })
    }
}

impl Drop for HealthProbePermit {
    fn drop(&mut self) {
        if let Ok(mut active) = self.admission.active.lock() {
            *active = active.saturating_sub(1);
        }
    }
}

impl HealthProbe {
    pub fn failed(error: String) -> Self {
        let (sender, receiver) = mpsc::channel();
        let _ = sender.send(Err(error));
        Self {
            receiver,
            deadline: Instant::now() + Duration::from_secs(1),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn poll(&mut self) -> Option<Result<(), String>> {
        if Instant::now() >= self.deadline {
            self.cancelled.store(true, Ordering::SeqCst);
            return Some(Err("Health check timed out.".to_string()));
        }
        match self.receiver.try_recv() {
            Ok(result) => Some(result),
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                Some(Err("Health check worker stopped unexpectedly.".to_string()))
            }
        }
    }
}

impl Drop for HealthProbe {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

pub fn start_health_probe(
    check: RunHealthCheck,
    timeout_ms: u64,
) -> Result<HealthProbe, HealthProbeStartError> {
    start_probe_with_operation(
        health_probe_admission(),
        timeout_ms,
        move |deadline, cancelled| check_health(&check, deadline, &cancelled),
    )
}

fn health_probe_admission() -> Arc<HealthProbeAdmission> {
    static ADMISSION: OnceLock<Arc<HealthProbeAdmission>> = OnceLock::new();
    Arc::clone(
        ADMISSION.get_or_init(|| Arc::new(HealthProbeAdmission::new(MAX_CONCURRENT_HEALTH_PROBES))),
    )
}

fn start_probe_with_operation<F>(
    admission: Arc<HealthProbeAdmission>,
    timeout_ms: u64,
    operation: F,
) -> Result<HealthProbe, HealthProbeStartError>
where
    F: FnOnce(Instant, Arc<AtomicBool>) -> Result<(), String> + Send + 'static,
{
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let permit = admission
        .acquire()
        .ok_or(HealthProbeStartError::CapacityExhausted)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("workspace-health-probe".to_string())
        .spawn(move || {
            let _permit = permit;
            let result = operation(deadline, worker_cancelled.clone());
            if !worker_cancelled.load(Ordering::SeqCst) {
                let _ = sender.send(result);
            }
        })
        .map_err(|error| {
            HealthProbeStartError::WorkerStart(format!(
                "Unable to start health check worker: {error}"
            ))
        })?;
    Ok(HealthProbe {
        receiver,
        deadline,
        cancelled,
    })
}

fn check_health(
    check: &RunHealthCheck,
    deadline: Instant,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    ensure_probe_active(deadline, cancelled)?;
    match check.kind {
        RunHealthCheckKind::Tcp => check_tcp(check, deadline, cancelled),
        RunHealthCheckKind::Http => check_http(check, deadline, cancelled),
    }
}

fn check_tcp(
    check: &RunHealthCheck,
    deadline: Instant,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let host = check
        .host
        .as_deref()
        .filter(|host| !host.trim().is_empty())
        .unwrap_or("127.0.0.1");
    let port = check
        .port
        .ok_or_else(|| "TCP health check needs a port.".to_string())?;
    let addresses = resolve_health_addresses(host, port, deadline, cancelled)?;
    if addresses.is_empty() {
        return Err(format!("No address resolved for {host}:{port}."));
    }

    check_tcp_addresses_with_clock(
        addresses,
        deadline,
        cancelled,
        Instant::now,
        |address, timeout| {
            TcpStream::connect_timeout(address, timeout)
                .map(|_| ())
                .map_err(|error| error.to_string())
        },
    )
    .map_err(|error| format!("TCP connection to {host}:{port} failed: {error}"))?;
    ensure_probe_active(deadline, cancelled)
}

fn check_tcp_addresses_with_clock<I, N, C>(
    addresses: I,
    deadline: Instant,
    cancelled: &AtomicBool,
    mut now: N,
    mut connect: C,
) -> Result<(), String>
where
    I: IntoIterator<Item = SocketAddr>,
    N: FnMut() -> Instant,
    C: FnMut(&SocketAddr, Duration) -> Result<(), String>,
{
    let mut last_error = None;
    for address in addresses {
        let timeout = remaining_probe_budget_at(deadline, now(), cancelled)?;
        match connect(&address, timeout) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "connection failed".to_string()))
}

fn check_http(
    check: &RunHealthCheck,
    deadline: Instant,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let url = check
        .url
        .as_deref()
        .ok_or_else(|| "HTTP health check needs a URL.".to_string())?;
    let client = reqwest::blocking::Client::builder()
        .dns_resolver(Arc::new(HealthDnsResolver))
        .build()
        .map_err(|error| format!("Unable to create the HTTP health client: {error}"))?;
    let response = dispatch_http_with_deadline(deadline, cancelled, |timeout| {
        client
            .get(url)
            .timeout(timeout)
            .send()
            .map_err(|error| format!("HTTP request to {url} failed: {error}"))
    })?;
    ensure_probe_active(deadline, cancelled)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "HTTP request to {url} returned {}.",
            response.status()
        ))
    }
}

fn dispatch_http_with_deadline<T, F>(
    deadline: Instant,
    cancelled: &AtomicBool,
    dispatch: F,
) -> Result<T, String>
where
    F: FnOnce(Duration) -> Result<T, String>,
{
    dispatch(remaining_probe_budget(deadline, cancelled)?)
}

fn remaining_probe_budget(deadline: Instant, cancelled: &AtomicBool) -> Result<Duration, String> {
    remaining_probe_budget_at(deadline, Instant::now(), cancelled)
}

fn remaining_probe_budget_at(
    deadline: Instant,
    now: Instant,
    cancelled: &AtomicBool,
) -> Result<Duration, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("Health check was cancelled.".to_string());
    }
    deadline
        .checked_duration_since(now)
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "Health check timed out.".to_string())
}

fn ensure_probe_active(deadline: Instant, cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("Health check was cancelled.".to_string());
    }
    if Instant::now() >= deadline {
        return Err("Health check timed out.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        net::{IpAddr, Ipv4Addr},
        sync::mpsc,
    };

    use super::*;

    #[test]
    fn exhausted_deadline_prevents_tcp_connection_attempts() {
        let cancelled = AtomicBool::new(false);
        let now = Instant::now();
        let deadline = now;
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8080);
        let mut attempts = 0;

        let result = check_tcp_addresses_with_clock(
            [address],
            deadline,
            &cancelled,
            || now,
            |_, _| {
                attempts += 1;
                Ok(())
            },
        );

        assert!(result.is_err());
        assert_eq!(attempts, 0);
    }

    #[test]
    fn each_tcp_address_uses_the_remaining_deadline_budget() {
        let cancelled = AtomicBool::new(false);
        let started = Instant::now();
        let deadline = started + Duration::from_millis(200);
        let addresses = [
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8080),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8081),
        ];
        let mut budgets = Vec::new();
        let mut times = [started, started + Duration::from_millis(20)].into_iter();

        let result = check_tcp_addresses_with_clock(
            addresses,
            deadline,
            &cancelled,
            || {
                times
                    .next()
                    .expect("each address should read the clock once")
            },
            |_, timeout| {
                budgets.push(timeout);
                Err("connection refused".to_string())
            },
        );

        assert!(result.is_err());
        assert_eq!(
            budgets,
            vec![Duration::from_millis(200), Duration::from_millis(180)]
        );
    }

    #[test]
    fn exhausted_deadline_prevents_http_dispatch() {
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now();
        let mut dispatched = false;

        let result = dispatch_http_with_deadline(deadline, &cancelled, |_| {
            dispatched = true;
            Ok(())
        });

        assert!(result.is_err());
        assert!(!dispatched);
    }

    #[test]
    fn cancelled_probe_retains_capacity_until_its_worker_exits() {
        let admission = Arc::new(HealthProbeAdmission::new(1));
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let (cancelled_sender, cancelled_receiver) = mpsc::channel();
        let probe =
            start_probe_with_operation(Arc::clone(&admission), 1_000, move |_, cancelled| {
                started_sender
                    .send(())
                    .expect("worker start should be reported");
                release_receiver.recv().expect("worker should be released");
                cancelled_sender
                    .send(cancelled.load(Ordering::SeqCst))
                    .expect("worker cancellation should be reported");
                Ok(())
            })
            .expect("first probe should be admitted");
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("worker should start");

        drop(probe);
        assert!(matches!(
            start_probe_with_operation(Arc::clone(&admission), 1_000, |_, _| Ok(())),
            Err(HealthProbeStartError::CapacityExhausted)
        ));
        release_sender.send(()).expect("worker should be released");
        assert!(cancelled_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("worker should observe cancellation"));
    }

    #[test]
    fn repeated_cancelled_probes_cannot_exceed_admission_limit() {
        let admission = Arc::new(HealthProbeAdmission::new(1));
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let probe = start_probe_with_operation(Arc::clone(&admission), 1_000, move |_, _| {
            started_sender
                .send(())
                .expect("worker start should be reported");
            release_receiver.recv().expect("worker should be released");
            Ok(())
        })
        .expect("first probe should be admitted");
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("worker should start");

        drop(probe);
        for _ in 0..3 {
            assert!(matches!(
                start_probe_with_operation(Arc::clone(&admission), 1_000, |_, _| Ok(())),
                Err(HealthProbeStartError::CapacityExhausted)
            ));
        }
        release_sender.send(()).expect("worker should be released");
    }
}
