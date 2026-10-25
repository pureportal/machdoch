#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("Cloud supervision requires Windows or Linux.");

#[cfg(windows)]
#[path = "windows.rs"]
mod isolation;
#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod isolation;

mod process_io;
mod protocol;
mod receipt;
#[cfg(windows)]
mod socket;
mod watchdog;

use machdoch_process::SupervisedChildSpawnError;
use process_io::{capture, EventSink, InputPipe};
use protocol::{read_control, validate_start, Control};
use receipt::StopReceipt;
use serde_json::json;
use std::{
    io,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use watchdog::Watchdog;

fn supervise(events: &EventSink) -> Result<(), String> {
    let (send, receive) = mpsc::sync_channel(8);
    thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let control = read_control(&mut input);
            let finished = !matches!(control, Ok(Some(_)));
            if send.send(control).is_err() || finished {
                break;
            }
        }
    });
    let mut watchdog = Watchdog::new();
    let mut child: Option<isolation::IsolatedChild> = None;
    let mut configuration: Option<isolation::Configuration> = None;
    let mut output = Vec::new();
    let mut input: Option<InputPipe> = None;
    let startup = Instant::now() + Duration::from_secs(30);
    let mut receipt: Option<StopReceipt> = None;
    let mut child_pid = None;
    let mut cleanup_uncertain = false;
    let outcome = (|| -> Result<&'static str, String> {
        loop {
            if events.failed() {
                return Err("Process stream failed or exceeded capacity".to_string());
            }
            if watchdog.expired() {
                break Ok("lease_expired");
            }
            if child.is_none() && Instant::now() >= startup {
                break Ok("start_expired");
            }
            if let Some(process) = child.as_mut() {
                if process
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    break Ok("completed");
                }
            }
            let control = match receive.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(Some(control))) => control,
                Ok(Ok(None)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Ok("parent_closed")
                }
                Ok(Err(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
            };
            match control {
                Control::Prepare {
                    receipt_path,
                    environment_id,
                    cgroup_root,
                } => {
                    if receipt.is_some() || child.is_some() {
                        return Err("An environment is already prepared".to_string());
                    }
                    let prepared =
                        isolation::Configuration::new(&environment_id, cgroup_root.as_deref())?;
                    receipt = Some(StopReceipt::prepare(&receipt_path, &environment_id)?);
                    configuration = Some(prepared);
                    events.emit(json!({"kind":"prepared","environmentId":environment_id}))?;
                }
                Control::Anchor { id } => {
                    watchdog.anchor(id.clone())?;
                    events.emit(json!({"kind":"anchored","id":id}))?;
                }
                Control::Start {
                    anchor_id,
                    allowance_ms,
                    max_duration_ms,
                    memory_limit_bytes,
                    program,
                    args,
                    directory,
                    environment,
                } => {
                    if child.is_some() {
                        return Err("A process is already running".to_string());
                    }
                    if receipt.is_none() {
                        return Err("Prepare an environment receipt before starting".to_string());
                    }
                    if !(64 * 1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&memory_limit_bytes) {
                        return Err("Invalid memory limit".to_string());
                    }
                    validate_start(&program, &args, &directory, &environment, max_duration_ms)?;
                    watchdog.renew(&anchor_id, allowance_ms)?;
                    watchdog.start(max_duration_ms);
                    let mut command = Command::new(program);
                    command
                        .args(args)
                        .current_dir(directory)
                        .env_clear()
                        .envs(environment)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped());
                    child = Some(
                        match isolation::spawn(
                            &mut command,
                            memory_limit_bytes,
                            configuration
                                .as_ref()
                                .ok_or("Missing isolation configuration")?,
                        ) {
                            Ok(process) => process,
                            Err(error) => {
                                cleanup_uncertain =
                                    matches!(error, SupervisedChildSpawnError::Isolation(_));
                                return Err(error.to_string());
                            }
                        },
                    );
                    let process = child.as_mut().ok_or("Missing supervised process")?;
                    let id = process.id();
                    child_pid = Some(id);
                    input = Some(InputPipe::new(
                        process.stdin.take().ok_or("Missing stdin")?,
                        events.clone(),
                    ));
                    events.emit(json!({"kind":"started","pid":id}))?;
                    output.push(capture(
                        process.stdout.take().ok_or("Missing stdout")?,
                        "stdout",
                        events.clone(),
                    ));
                    output.push(capture(
                        process.stderr.take().ok_or("Missing stderr")?,
                        "stderr",
                        events.clone(),
                    ));
                }
                Control::Renew {
                    anchor_id,
                    allowance_ms,
                } => {
                    if child.is_none() {
                        return Err("No process is running".to_string());
                    }
                    watchdog.renew(&anchor_id, allowance_ms)?;
                    events.emit(json!({"kind":"renewed","id":anchor_id}))?;
                }
                Control::Input { id, data } => {
                    input
                        .as_mut()
                        .ok_or("No process is running")?
                        .write(id, data)?;
                }
                Control::Stop => break Ok("canceled"),
            }
        }
    })();
    let reason = outcome.as_ref().copied().unwrap_or("control_error");
    if let Some(input) = &input {
        input.cancel();
    }
    let exit_code = if let Some(mut process) = child.take() {
        let status = isolation::stop(&mut process)?;
        status.code()
    } else {
        None
    };
    if cleanup_uncertain {
        return Err("Process isolation cleanup is unconfirmed".to_string());
    }
    if let Some(input) = input {
        input.finish()?;
    }
    if let Some(receipt) = receipt {
        receipt.stopped(reason, child_pid, exit_code)?;
    }
    let drain_deadline = Instant::now() + Duration::from_secs(1);
    while output.iter().any(|handle| !handle.is_finished()) && Instant::now() < drain_deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let drained = output.iter().all(|handle| handle.is_finished());
    if !drained {
        events.cancel_capture();
    }
    for handle in output {
        handle.join().map_err(|_| "Process output thread failed")?;
    }
    if !drained {
        return Err("Process output could not be drained".to_string());
    }
    outcome?;
    events.emit(json!({"kind":"stopped","reason":reason,"exitCode":exit_code}))
}

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if !arguments.is_empty() {
        #[cfg(windows)]
        let result = socket::command(&arguments);
        #[cfg(not(windows))]
        let result: Result<(), String> = Err("Unexpected supervisor arguments".to_string());
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let (events, finished) = process_io::events();
    let result = supervise(&events);
    if let Err(error) = &result {
        let _ = events.emit(json!({"kind":"error","message":error}));
    }
    drop(events);
    let _ = finished.recv_timeout(Duration::from_secs(1));
    if result.is_err() {
        std::process::exit(1);
    }
}
