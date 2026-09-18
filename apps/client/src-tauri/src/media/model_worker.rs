use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Command, ExitStatus, Output, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use crate::child_process::SupervisedChild;

use super::{worker_output::WorkerProgress, MediaResult};

const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const DIAGNOSTIC_LIMIT: usize = 256 * 1024;

pub(super) struct ResidentWorker {
    child: SupervisedChild,
    responses: mpsc::Receiver<MediaResult<Vec<u8>>>,
    progress: mpsc::Receiver<WorkerProgress>,
    diagnostics: Arc<Mutex<Vec<u8>>>,
    readers: Vec<thread::JoinHandle<()>>,
    pub(super) identity: String,
    pub(super) expires_at: Instant,
}

impl ResidentWorker {
    pub(super) fn spawn(mut command: Command, identity: String) -> MediaResult<Self> {
        command
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = SupervisedChild::spawn_with_required_isolation(&mut command)
            .map_err(|error| format!("Could not start model worker: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Model worker stdout is unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Model worker stderr is unavailable")?;
        let (response_sender, responses) = mpsc::sync_channel(1);
        let (progress_sender, progress) = mpsc::sync_channel(64);
        let diagnostics = Arc::new(Mutex::new(Vec::new()));
        let retained = diagnostics.clone();
        let readers = vec![
            thread::spawn(move || {
                let mut stream = BufReader::new(stdout);
                loop {
                    let mut line = Vec::new();
                    let result = (&mut stream)
                        .take(RESPONSE_LIMIT as u64 + 1)
                        .read_until(b'\n', &mut line);
                    let response = match result {
                        Ok(0) => break,
                        Ok(_) if line.len() > RESPONSE_LIMIT => {
                            Err("Model worker response is too large".into())
                        }
                        Ok(_) => Ok(line),
                        Err(error) => Err(format!("Could not read model worker response: {error}")),
                    };
                    let failed = response.is_err();
                    if response_sender.try_send(response).is_err() || failed {
                        break;
                    }
                }
            }),
            thread::spawn(move || {
                let mut stream = stderr;
                let mut buffer = [0; 8192];
                let mut line = Vec::new();
                loop {
                    let count = match stream.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => count,
                        Err(error) => {
                            retained
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .extend_from_slice(
                                    format!("\nDiagnostic reader failed: {error}").as_bytes(),
                                );
                            break;
                        }
                    };
                    let mut tail = retained.lock().unwrap_or_else(|error| error.into_inner());
                    tail.extend_from_slice(&buffer[..count]);
                    let excess = tail.len().saturating_sub(DIAGNOSTIC_LIMIT);
                    tail.drain(..excess);
                    drop(tail);
                    for byte in &buffer[..count] {
                        if *byte == b'\n' {
                            if let Some(payload) = line.strip_prefix(b"MACHDOCH_PROGRESS ") {
                                if let Ok(event) = serde_json::from_slice::<WorkerProgress>(payload)
                                {
                                    if event.progress.is_finite()
                                        && (0.0..=1.0).contains(&event.progress)
                                        && event.stage.len() <= 160
                                    {
                                        let _ = progress_sender.try_send(event);
                                    }
                                }
                            }
                            line.clear();
                        } else if line.len() < 8192 {
                            line.push(*byte);
                        }
                    }
                }
            }),
        ];
        Ok(Self {
            child,
            responses,
            progress,
            diagnostics,
            readers,
            identity,
            expires_at: Instant::now(),
        })
    }

    pub(super) fn alive(&mut self) -> MediaResult<bool> {
        self.child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| format!("Could not monitor model worker: {error}"))
    }

    pub(super) fn request(
        &mut self,
        command: &str,
        input: Option<&[u8]>,
        timeout: Duration,
        mut monitor: impl FnMut(Option<WorkerProgress>) -> MediaResult<()>,
    ) -> MediaResult<Output> {
        monitor(None)?;
        let request = input
            .map(serde_json::from_slice::<serde_json::Value>)
            .transpose()
            .map_err(|error| format!("Invalid model request: {error}"))?;
        let mut bytes =
            serde_json::to_vec(&serde_json::json!({"command": command, "request": request}))
                .map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        if bytes.len() > RESPONSE_LIMIT {
            return Err("Model worker request is too large".into());
        }
        self.diagnostics
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        for _ in self.progress.try_iter() {}
        let mut stdin = self
            .child
            .stdin
            .take()
            .ok_or("Model worker stdin is unavailable")?;
        let (written, writing) = mpsc::sync_channel(1);
        let writer = thread::spawn(move || {
            let result = stdin.write_all(&bytes).and_then(|_| stdin.flush());
            let _ = written.send((stdin, result));
        });
        let started = Instant::now();
        let result = (|| loop {
            monitor(None)?;
            for event in self.progress.try_iter() {
                monitor(Some(event))?;
            }
            if let Ok((stdin, result)) = writing.try_recv() {
                self.child.stdin = Some(stdin);
                result.map_err(|error| format!("Could not write model request: {error}"))?;
            }
            match self.responses.try_recv() {
                Ok(response) => {
                    let envelope: serde_json::Value = serde_json::from_slice(&response?)
                        .map_err(|error| format!("Model worker returned invalid JSON: {error}"))?;
                    if let Some(error) = envelope.get("error").and_then(|error| error.as_str()) {
                        return Err(error.to_string());
                    }
                    let result = envelope
                        .get("result")
                        .filter(|result| result.is_object())
                        .ok_or("Model worker returned no result")?;
                    if let Some(error) = result.get("error").and_then(|error| error.as_str()) {
                        return Err(error.to_string());
                    }
                    if command == "generate" {
                        let retention = envelope["retentionSeconds"]
                            .as_f64()
                            .filter(|seconds| {
                                seconds.is_finite() && (120.0..=600.0).contains(seconds)
                            })
                            .ok_or("Model worker returned invalid retention")?;
                        self.expires_at = Instant::now() + Duration::from_secs_f64(retention);
                    }
                    return Ok(Output {
                        status: ExitStatus::default(),
                        stdout: serde_json::to_vec(result).map_err(|error| error.to_string())?,
                        stderr: self
                            .diagnostics
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .clone(),
                    });
                }
                Err(mpsc::TryRecvError::Disconnected) => return Err("Model worker crashed".into()),
                Err(mpsc::TryRecvError::Empty) => {}
            }
            if started.elapsed() >= timeout {
                return Err("Local model worker timed out: execution deadline exceeded".into());
            }
            if !self.alive()? {
                return Err("Model worker exited before completing the request".into());
            }
            thread::sleep(Duration::from_millis(50));
        })();
        if result.is_err() {
            self.stop()?;
        }
        writer.join().map_err(|_| "Model request writer failed")?;
        if self.child.stdin.is_none() {
            if let Ok((stdin, result)) = writing.try_recv() {
                self.child.stdin = Some(stdin);
                result.map_err(|error| format!("Could not write model request: {error}"))?;
            }
        }
        result.map_err(|error| {
            let tail = self
                .diagnostics
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            format!("{error}\n{}", String::from_utf8_lossy(&tail))
        })
    }

    pub(super) fn stop(&mut self) -> MediaResult<()> {
        self.child
            .terminate_and_reap()
            .map_err(|error| format!("Could not release model worker: {error}"))?;
        for reader in self.readers.drain(..) {
            reader
                .join()
                .map_err(|_| "Model worker output reader failed")?;
        }
        Ok(())
    }
}

impl Drop for ResidentWorker {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("{error}");
        }
    }
}
