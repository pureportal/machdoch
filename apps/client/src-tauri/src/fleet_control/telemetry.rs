use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::System;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HostTelemetry {
    captured_at: u64,
    platform: &'static str,
    architecture: &'static str,
    cpu_count: usize,
    cpu_usage_percent: Option<f32>,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    uptime_seconds: u64,
}

struct TelemetrySampler {
    system: System,
    sampled_at: Instant,
    cpu_usage: Option<f32>,
}

pub(super) fn collect() -> Option<HostTelemetry> {
    static SAMPLER: OnceLock<Mutex<TelemetrySampler>> = OnceLock::new();
    let mut sampler = SAMPLER
        .get_or_init(|| {
            let mut system = System::new();
            system.refresh_cpu_usage();
            Mutex::new(TelemetrySampler {
                system,
                sampled_at: Instant::now(),
                cpu_usage: None,
            })
        })
        .lock()
        .ok()?;
    if sampler.sampled_at.elapsed() >= Duration::from_millis(250) {
        sampler.system.refresh_cpu_usage();
        let usage = sampler.system.global_cpu_usage();
        sampler.cpu_usage = usage.is_finite().then(|| usage.clamp(0.0, 100.0));
        sampler.sampled_at = Instant::now();
    }
    sampler.system.refresh_memory();
    Some(HostTelemetry {
        captured_at: super::now_millis(),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        cpu_count: sampler.system.cpus().len().max(1),
        cpu_usage_percent: sampler.cpu_usage,
        memory_total_bytes: sampler.system.total_memory(),
        memory_used_bytes: sampler
            .system
            .used_memory()
            .min(sampler.system.total_memory()),
        uptime_seconds: System::uptime(),
    })
}
