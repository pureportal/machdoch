use std::{
    io::Write,
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use crate::child_process::SupervisedChild;

use super::{
    database, model_worker::ResidentWorker, subject_cutout, worker_output, MediaResult,
    MediaRuntimePaths,
};

const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
static MANAGER: OnceLock<MediaResult<ModelMemoryManager>> = OnceLock::new();

#[cfg(test)]
#[path = "model_memory_tests.rs"]
mod tests;

struct Work {
    process: Command,
    command: String,
    input: Option<Vec<u8>>,
    timeout: Duration,
    cancellation: Option<(MediaRuntimePaths, String)>,
    result: mpsc::SyncSender<MediaResult<Output>>,
}

enum Request {
    Run(Work),
    Release(mpsc::SyncSender<MediaResult<()>>),
    Shutdown,
}

struct ModelMemoryManager {
    requests: mpsc::Sender<Request>,
    stopping: Arc<AtomicBool>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}

fn manager() -> MediaResult<&'static ModelMemoryManager> {
    MANAGER
        .get_or_init(|| {
            let (requests, receiver) = mpsc::channel();
            let stopping = Arc::new(AtomicBool::new(false));
            let worker_stopping = stopping.clone();
            let thread = thread::Builder::new()
                .name("media-model-memory".into())
                .spawn(move || manage(receiver, &worker_stopping))
                .map_err(|error| format!("Could not start model memory monitor: {error}"))?;
            Ok(ModelMemoryManager {
                requests,
                stopping,
                thread: Mutex::new(Some(thread)),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub(super) fn start() -> MediaResult<()> {
    manager().map(|_| ())
}

pub(super) fn run(
    process: Command,
    command: &str,
    input: Option<&[u8]>,
    timeout: Duration,
    cancellation: Option<(&MediaRuntimePaths, &str)>,
) -> MediaResult<Output> {
    let manager = manager()?;
    if manager.stopping.load(Ordering::Acquire) {
        return Err("Media Studio is shutting down".into());
    }
    let (result, receiver) = mpsc::sync_channel(1);
    manager
        .requests
        .send(Request::Run(Work {
            process,
            command: command.into(),
            input: input.map(Vec::from),
            timeout,
            cancellation: cancellation.map(|(paths, run)| {
                (
                    MediaRuntimePaths {
                        database: paths.database.clone(),
                        blobs: paths.blobs.clone(),
                    },
                    run.into(),
                )
            }),
            result,
        }))
        .map_err(|_| "Model memory monitor stopped")?;
    receiver
        .recv()
        .map_err(|_| "Model memory monitor stopped")?
}

pub(super) fn release_idle() -> MediaResult<()> {
    let Some(manager) = MANAGER.get() else {
        return Ok(());
    };
    let manager = manager.as_ref().map_err(Clone::clone)?;
    let (result, receiver) = mpsc::sync_channel(1);
    manager
        .requests
        .send(Request::Release(result))
        .map_err(|_| "Model memory monitor stopped")?;
    receiver
        .recv()
        .map_err(|_| "Model memory monitor stopped")?
}

pub(crate) fn shutdown() {
    let Some(Ok(manager)) = MANAGER.get() else {
        return;
    };
    manager.stopping.store(true, Ordering::Release);
    let _ = manager.requests.send(Request::Shutdown);
    if let Some(thread) = manager
        .thread
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        if thread.join().is_err() {
            eprintln!("Model memory monitor failed during shutdown");
        }
    }
    if let Err(error) = subject_cutout::release_session() {
        eprintln!("{error}");
    }
}

fn release(resident: &mut Option<ResidentWorker>) -> MediaResult<()> {
    if let Some(mut worker) = resident.take() {
        worker.stop()?;
    }
    Ok(())
}

fn manage(receiver: mpsc::Receiver<Request>, stopping: &AtomicBool) {
    let mut resident = None;
    let mut next_watchdog = Instant::now() + WATCHDOG_INTERVAL;
    loop {
        match receiver.recv_timeout(next_watchdog.saturating_duration_since(Instant::now())) {
            Ok(Request::Run(work)) => {
                let result = execute(&mut resident, &work, stopping);
                if result.is_err() {
                    if let Err(error) = release(&mut resident) {
                        eprintln!("{error}");
                    }
                }
                let _ = work.result.send(result);
            }
            Ok(Request::Release(result)) => {
                let _ = result.send(release(&mut resident));
            }
            Ok(Request::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if stopping.load(Ordering::Acquire) {
            break;
        }
        if Instant::now() >= next_watchdog {
            let result = monitor_idle(&mut resident, stopping);
            if let Err(error) = result {
                eprintln!("Media model watchdog: {error}");
                if let Err(error) = release(&mut resident) {
                    eprintln!("{error}");
                }
            }
            subject_cutout::release_expired_session();
            next_watchdog = Instant::now() + WATCHDOG_INTERVAL;
        }
    }
    if let Err(error) = release(&mut resident) {
        eprintln!("{error}");
    }
}

fn monitor_idle(resident: &mut Option<ResidentWorker>, stopping: &AtomicBool) -> MediaResult<()> {
    let Some(worker) = resident.as_mut() else {
        return Ok(());
    };
    if Instant::now() >= worker.expires_at || !worker.alive()? || system_memory_pressure() {
        return release(resident);
    }
    let output = worker.request("memory", None, Duration::from_secs(10), |_| {
        check_shutdown(stopping)
    })?;
    let snapshot: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    if snapshot["pressure"]
        .as_bool()
        .ok_or("Model memory status is unavailable")?
    {
        release(resident)?;
    }
    Ok(())
}

pub(super) fn system_memory_pressure() -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.total_memory() > 0
        && system.available_memory() < (system.total_memory() / 10).min(2 * 1024_u64.pow(3))
}

fn check_shutdown(stopping: &AtomicBool) -> MediaResult<()> {
    if stopping.load(Ordering::Acquire) {
        Err("Media Studio is shutting down".into())
    } else {
        Ok(())
    }
}

fn execute(
    resident: &mut Option<ResidentWorker>,
    work: &Work,
    stopping: &AtomicBool,
) -> MediaResult<Output> {
    let mut next_cancellation_check = Instant::now();
    let mut monitor = |event: Option<worker_output::WorkerProgress>| {
        check_shutdown(stopping)?;
        if let Some((paths, run)) = &work.cancellation {
            if Instant::now() >= next_cancellation_check {
                if database::is_cancellation_requested(paths, run)? {
                    return Err("Local generation was canceled".into());
                }
                next_cancellation_check = Instant::now() + Duration::from_millis(500);
            }
            if let Some(event) = event {
                if !database::workflow::progress(paths, run, &event.stage, event.progress)? {
                    let node_types: &[&str] = if work.command == "generate-video" {
                        &["task.generate-video"]
                    } else {
                        &["task.generate-image", "task.edit-image"]
                    };
                    database::transition_nodes_by_type(
                        paths,
                        run,
                        node_types,
                        "running",
                        Some("generating"),
                        Some(&event.stage),
                        Some(event.progress),
                    )?;
                }
            }
        }
        Ok(())
    };
    monitor(None)?;
    let identity = format!("{:?}", work.process);
    let uses_image_worker = matches!(work.command.as_str(), "generate" | "probe");
    if let Some(worker) = resident.as_mut() {
        if (uses_image_worker && worker.identity != identity)
            || Instant::now() >= worker.expires_at
            || !worker.alive()?
            || system_memory_pressure()
        {
            release(resident)?;
        }
    }
    if work.command == "generate" || (work.command == "probe" && resident.is_some()) {
        if resident.is_none() {
            *resident = Some(ResidentWorker::spawn(
                copy_command(&work.process),
                identity,
            )?);
        }
        return resident
            .as_mut()
            .ok_or("Model worker is unavailable")?
            .request(&work.command, work.input.as_deref(), work.timeout, monitor);
    }
    if matches!(
        work.command.as_str(),
        "prepare-mask" | "image-mask" | "mask-composite" | "canny"
    ) {
        let mut next_memory_check = Instant::now() + WATCHDOG_INTERVAL;
        return run_isolated(work, |event| {
            monitor(event)?;
            if Instant::now() >= next_memory_check {
                if let Err(error) = monitor_idle(resident, stopping) {
                    eprintln!("Media model watchdog: {error}");
                    release(resident)?;
                }
                next_memory_check = Instant::now() + WATCHDOG_INTERVAL;
            }
            Ok(())
        });
    }
    release(resident)?;
    run_isolated(work, monitor)
}

fn copy_command(source: &Command) -> Command {
    let mut command = Command::new(source.get_program());
    command.args(source.get_args());
    for (key, value) in source.get_envs() {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    command
}

fn run_isolated(
    work: &Work,
    mut monitor: impl FnMut(Option<worker_output::WorkerProgress>) -> MediaResult<()>,
) -> MediaResult<Output> {
    monitor(None)?;
    let mut command = copy_command(&work.process);
    command
        .arg(&work.command)
        .stdin(if work.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = SupervisedChild::spawn_with_required_isolation(&mut command)
        .map_err(|error| format!("Could not start local model worker: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Generation stdout is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Generation stderr is unavailable")?;
    let (sender, progress) = mpsc::sync_channel(64);
    let stdout_reader = thread::spawn(move || worker_output::drain(stdout, 2 * 1024 * 1024, None));
    let stderr_reader =
        thread::spawn(move || worker_output::drain(stderr, 256 * 1024, Some(sender)));
    let writer = work.input.as_ref().map(|bytes| {
        let bytes = bytes.clone();
        let stdin = child.stdin.take();
        thread::spawn(move || {
            stdin
                .ok_or_else(|| "Model worker stdin is unavailable".to_string())?
                .write_all(&bytes)
                .map_err(|error| format!("Could not write model request: {error}"))
        })
    });
    let started = Instant::now();
    let result: MediaResult<std::process::ExitStatus> = (|| loop {
        monitor(None)?;
        for event in progress.try_iter() {
            monitor(Some(event))?;
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break Ok(status);
        }
        if started.elapsed() >= work.timeout {
            break Err("Local model worker timed out: execution deadline exceeded".into());
        }
        thread::sleep(Duration::from_millis(50));
    })();
    child
        .terminate_and_reap()
        .map_err(|error| format!("Could not release model worker: {error}"))?;
    let stdout = stdout_reader
        .join()
        .map_err(|_| "Generation output reader failed")?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "Generation diagnostic reader failed")?;
    let written = writer
        .map(|writer| writer.join().map_err(|_| "Generation input writer failed"))
        .transpose()?;
    let status = result?;
    if let Some(written) = written {
        written?;
    }
    Ok(Output {
        status,
        stdout: stdout?,
        stderr: stderr?,
    })
}
