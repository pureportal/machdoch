use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    io::{self, Read, Write},
    process::ChildStdin,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::Duration,
};

struct InputMessage {
    id: String,
    bytes: Option<Vec<u8>>,
}

pub struct InputPipe {
    send: mpsc::SyncSender<InputMessage>,
    worker: thread::JoinHandle<()>,
    canceled: Arc<AtomicBool>,
    closed: bool,
}

impl InputPipe {
    pub fn new(mut input: ChildStdin, events: EventSink) -> Self {
        let (send, receive) = mpsc::sync_channel::<InputMessage>(4);
        let canceled = Arc::new(AtomicBool::new(false));
        let worker_canceled = canceled.clone();
        let worker = thread::spawn(move || {
            for message in receive {
                if worker_canceled.load(Ordering::Acquire) {
                    break;
                }
                if let Some(bytes) = message.bytes {
                    if input.write_all(&bytes).and_then(|_| input.flush()).is_err() {
                        if !worker_canceled.load(Ordering::Acquire) {
                            events.fail();
                        }
                        break;
                    }
                } else {
                    drop(input);
                    let _ = events.emit(json!({"kind":"input_written","id":message.id}));
                    return;
                }
                if worker_canceled.load(Ordering::Acquire) {
                    break;
                }
                if events
                    .emit(json!({"kind":"input_written","id":message.id}))
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            send,
            worker,
            canceled,
            closed: false,
        }
    }

    pub fn write(&mut self, id: String, data: Option<String>) -> Result<(), String> {
        if self.closed || id.is_empty() || id.len() > 64 {
            return Err("Process input is closed or its request is invalid".to_string());
        }
        let bytes = data
            .map(|value| {
                if value.len() > 87384 {
                    return Err("Process input exceeds its limit".to_string());
                }
                let decoded = STANDARD
                    .decode(value)
                    .map_err(|_| "Invalid process input".to_string())?;
                if decoded.len() > 65536 {
                    return Err("Process input exceeds its limit".to_string());
                }
                Ok(decoded)
            })
            .transpose()?;
        self.closed = bytes.is_none();
        self.send
            .try_send(InputMessage { id, bytes })
            .map_err(|_| "Process input queue is unavailable".to_string())
    }

    pub fn cancel(&self) {
        self.canceled.store(true, Ordering::Release);
    }

    pub fn finish(self) -> Result<(), String> {
        drop(self.send);
        self.worker
            .join()
            .map_err(|_| "Process input thread failed".to_string())
    }
}

#[derive(Clone)]
pub struct EventSink {
    send: mpsc::SyncSender<Value>,
    failed: Arc<AtomicBool>,
    capture_canceled: Arc<AtomicBool>,
}
impl EventSink {
    fn capture(&self, mut value: Value) -> Result<(), String> {
        loop {
            if self.capture_canceled.load(Ordering::Acquire) {
                return Err("Capture stopped".to_string());
            }
            match self.send.try_send(value) {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Full(pending)) => {
                    value = pending;
                    thread::sleep(Duration::from_millis(5));
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    self.fail();
                    return Err("Process event receiver closed".to_string());
                }
            }
        }
    }
    pub fn cancel_capture(&self) {
        self.capture_canceled.store(true, Ordering::Release);
    }
    pub fn emit(&self, value: Value) -> Result<(), String> {
        self.send.try_send(value).map_err(|_| {
            self.failed.store(true, Ordering::Release);
            "Process event queue is unavailable".to_string()
        })
    }
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
    fn fail(&self) {
        self.failed.store(true, Ordering::Release);
    }
}

pub fn events() -> (EventSink, mpsc::Receiver<()>) {
    let (send, receive) = mpsc::sync_channel::<Value>(128);
    let (done, completed) = mpsc::channel();
    let failed = Arc::new(AtomicBool::new(false));
    let output_failed = failed.clone();
    thread::spawn(move || {
        let mut output = io::stdout().lock();
        for value in receive {
            if serde_json::to_writer(&mut output, &value).is_err()
                || output.write_all(b"\n").is_err()
                || output.flush().is_err()
            {
                output_failed.store(true, Ordering::Release);
                break;
            }
        }
        let _ = done.send(());
    });
    (
        EventSink {
            send,
            failed,
            capture_canceled: Arc::new(AtomicBool::new(false)),
        },
        completed,
    )
}

pub fn capture(
    mut input: impl Read + Send + 'static,
    kind: &'static str,
    events: EventSink,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if events
                        .capture(json!({"kind":kind,"data":STANDARD.encode(&buffer[..count])}))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    events.fail();
                    break;
                }
            }
        }
    })
}
