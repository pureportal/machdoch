use std::{
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;

use super::{database, MediaResult};

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolProbe {
    status: &'static str,
    version: Option<String>,
    diagnostic: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NvidiaGpu {
    name: String,
    memory_total_mb: Option<u64>,
    driver_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalRuntimeSupport {
    cpu_utilities: &'static str,
    cuda: &'static str,
    amd: &'static str,
    apple_silicon: &'static str,
    direct_ml: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaHardwareInspection {
    inspected_at: String,
    operating_system: String,
    architecture: String,
    cpu_label: String,
    logical_cpu_count: u32,
    total_memory_bytes: Option<u64>,
    available_memory_bytes: Option<u64>,
    storage_free_bytes: Option<u64>,
    ffmpeg: ToolProbe,
    ffprobe: ToolProbe,
    nvidia_smi: ToolProbe,
    nvidia_gpus: Vec<NvidiaGpu>,
    runtime_support: LocalRuntimeSupport,
    warnings: Vec<String>,
}

struct CommandProbeOutput {
    probe: ToolProbe,
    stdout: String,
}

pub(crate) fn inspect(storage_path: &Path) -> MediaResult<MediaHardwareInspection> {
    let logical_cpu_count = std::thread::available_parallelism()
        .map(|count| count.get() as u32)
        .unwrap_or(1);
    let cpu_label = std::env::var("PROCESSOR_IDENTIFIER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.chars().take(256).collect())
        .unwrap_or_else(|| format!("{} CPU", std::env::consts::ARCH));
    let (total_memory_bytes, available_memory_bytes) = memory_bytes();
    let storage_free_bytes = available_storage_bytes(storage_path);
    let ffmpeg_output = probe_command("ffmpeg", &["-hide_banner", "-version"]);
    let ffprobe_output = probe_command("ffprobe", &["-hide_banner", "-version"]);
    let nvidia_output = probe_command(
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total,driver_version",
            "--format=csv,noheader,nounits",
        ],
    );
    let nvidia_gpus = if nvidia_output.probe.status == "available" {
        parse_nvidia_gpus(&nvidia_output.stdout)
    } else {
        Vec::new()
    };
    let mut warnings = Vec::new();
    if nvidia_gpus.is_empty() {
        warnings.push(
            "No NVIDIA device was confirmed by nvidia-smi; CUDA model packs remain unsupported until a real runner probe passes."
                .to_string(),
        );
    } else {
        warnings.push(
            "NVIDIA driver visibility does not prove CUDA, PyTorch, or model compatibility; each runtime pack still needs a kernel probe."
                .to_string(),
        );
    }
    if ffmpeg_output.probe.status != "available" {
        warnings.push(
            "FFmpeg was not found on PATH; video probing and encoding are unavailable until a pinned build is installed."
                .to_string(),
        );
    }
    if ffprobe_output.probe.status != "available" {
        warnings.push(
            "ffprobe was not found on PATH; container, stream, duration, and codec claims cannot be verified."
                .to_string(),
        );
    }

    Ok(MediaHardwareInspection {
        inspected_at: database::now(),
        operating_system: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        cpu_label,
        logical_cpu_count,
        total_memory_bytes,
        available_memory_bytes,
        storage_free_bytes,
        ffmpeg: ffmpeg_output.probe,
        ffprobe: ffprobe_output.probe,
        nvidia_smi: nvidia_output.probe,
        nvidia_gpus,
        runtime_support: LocalRuntimeSupport {
            cpu_utilities: "available",
            cuda: if cfg!(target_os = "windows") {
                "driver-probe-only"
            } else {
                "not-validated"
            },
            amd: "not-validated",
            apple_silicon: if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                "hardware-visible-runtime-unvalidated"
            } else {
                "not-applicable"
            },
            direct_ml: if cfg!(target_os = "windows") {
                "not-validated"
            } else {
                "not-applicable"
            },
        },
        warnings,
    })
}

fn probe_command(program: &str, arguments: &[&str]) -> CommandProbeOutput {
    let mut child = match Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return CommandProbeOutput {
                probe: ToolProbe {
                    status: "unavailable",
                    version: None,
                    diagnostic: "Executable was not found on PATH.".to_string(),
                },
                stdout: String::new(),
            };
        }
        Err(error) => {
            return CommandProbeOutput {
                probe: ToolProbe {
                    status: "unavailable",
                    version: None,
                    diagnostic: format!("Probe could not start: {error}"),
                },
                stdout: String::new(),
            };
        }
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return CommandProbeOutput {
                    probe: ToolProbe {
                        status: "timed-out",
                        version: None,
                        diagnostic: "Probe exceeded the three-second deadline and was terminated."
                            .to_string(),
                    },
                    stdout: String::new(),
                };
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return CommandProbeOutput {
                    probe: ToolProbe {
                        status: "unavailable",
                        version: None,
                        diagnostic: format!("Probe status could not be read: {error}"),
                    },
                    stdout: String::new(),
                };
            }
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            return CommandProbeOutput {
                probe: ToolProbe {
                    status: "unavailable",
                    version: None,
                    diagnostic: format!("Probe output could not be read: {error}"),
                },
                stdout: String::new(),
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let first_line = stdout
        .lines()
        .next()
        .or_else(|| stderr.lines().next())
        .map(|line| line.chars().take(256).collect::<String>());
    let success = output.status.success();
    CommandProbeOutput {
        probe: ToolProbe {
            status: if success { "available" } else { "unavailable" },
            version: success.then(|| first_line.clone()).flatten(),
            diagnostic: if success {
                "Probe completed within its deadline.".to_string()
            } else {
                first_line.unwrap_or_else(|| format!("Probe exited with {}.", output.status))
            },
        },
        stdout,
    }
}

fn parse_nvidia_gpus(stdout: &str) -> Vec<NvidiaGpu> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(',').map(str::trim);
            let name = fields.next()?.to_string();
            let memory_total_mb = fields.next()?.parse::<u64>().ok();
            let driver_version = fields.next()?.to_string();
            if name.is_empty() || driver_version.is_empty() {
                return None;
            }
            Some(NvidiaGpu {
                name,
                memory_total_mb,
                driver_version,
            })
        })
        .collect()
}

#[cfg(windows)]
fn memory_bytes() -> (Option<u64>, Option<u64>) {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    match unsafe { GlobalMemoryStatusEx(&mut status) } {
        Ok(()) => (Some(status.ullTotalPhys), Some(status.ullAvailPhys)),
        Err(_) => (None, None),
    }
}

#[cfg(not(windows))]
fn memory_bytes() -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[cfg(windows)]
pub(crate) fn available_storage_bytes(path: &Path) -> Option<u64> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDiskFreeSpaceExW};

    let path: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0_u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(path.as_ptr()), Some(&mut available), None, None) }
        .ok()
        .map(|_| available)
}

#[cfg(not(windows))]
pub(crate) fn available_storage_bytes(_path: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_nvidia_devices_without_inventing_missing_memory() {
        let devices =
            parse_nvidia_gpus("NVIDIA RTX 4090, 24564, 591.22\nNVIDIA RTX Test, unknown, 591.22");
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].memory_total_mb, Some(24_564));
        assert_eq!(devices[1].memory_total_mb, None);
    }
}
