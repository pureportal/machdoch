use super::*;
use std::{fs, path::PathBuf, time::SystemTime};

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-model-memory-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("worker.py"),
            r#"import json, os, pathlib, sys, time
root = pathlib.Path(__file__).parent
if sys.argv[1] != 'serve':
    if sys.argv[1] == 'canny':
        time.sleep((json.load(sys.stdin) or {}).get('delay', 0))
    print(json.dumps({'pid': os.getpid()}))
    sys.exit(0)
for line in sys.stdin:
    envelope = json.loads(line)
    request = envelope.get('request') or {}
    if request.get('delay'):
        (root / 'active').write_text(str(os.getpid()))
        time.sleep(request['delay'])
    if request.get('fail'):
        print(json.dumps({'error': 'CUDA out of memory'}), flush=True)
        sys.exit(2)
    if request.get('crash'):
        sys.exit(3)
    if envelope['command'] == 'memory':
        result = {'pressure': (root / 'pressure').exists()}
    else:
        result = {'pid': os.getpid(), 'prompt': request.get('prompt')}
    print(json.dumps({'result': result, 'retentionSeconds': 120}), flush=True)
"#,
        )
        .unwrap();
        Self { root }
    }

    fn work(
        &self,
        command: &str,
        input: serde_json::Value,
    ) -> (Work, mpsc::Receiver<MediaResult<Output>>) {
        let mut process = Command::new("python");
        process
            .args(["-I", "-Xutf8"])
            .arg(self.root.join("worker.py"));
        let (result, receiver) = mpsc::sync_channel(1);
        (
            Work {
                process,
                command: command.into(),
                input: Some(serde_json::to_vec(&input).unwrap()),
                timeout: Duration::from_secs(10),
                cancellation: None,
                result,
            },
            receiver,
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn pid(output: &Output) -> u32 {
    serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["pid"]
        .as_u64()
        .unwrap() as u32
}

fn assert_reaped(pid: u32) {
    assert!(
        sysinfo::System::new_all()
            .process(sysinfo::Pid::from_u32(pid))
            .is_none(),
        "worker {pid} survived cleanup"
    );
}

#[test]
fn reuses_worker_for_images_and_probes_without_extending_retention_for_probes() {
    let fixture = Fixture::new();
    let stopping = AtomicBool::new(false);
    let mut resident = None;
    let (first, _) = fixture.work("generate", serde_json::json!({"prompt":"first"}));
    let first = execute(&mut resident, &first, &stopping).unwrap();
    let deadline = resident.as_ref().unwrap().expires_at;
    let (probe, _) = fixture.work("probe", serde_json::json!({}));
    let probe = execute(&mut resident, &probe, &stopping).unwrap();
    assert_eq!(pid(&first), pid(&probe));
    assert_eq!(deadline, resident.as_ref().unwrap().expires_at);
    let (second, _) = fixture.work("generate", serde_json::json!({"prompt":"zweite – 画像"}));
    let second = execute(&mut resident, &second, &stopping).unwrap();
    assert_eq!(pid(&first), pid(&second));
    assert!(resident.as_ref().unwrap().expires_at > deadline);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&second.stdout).unwrap()["prompt"],
        "zweite – 画像"
    );
    release(&mut resident).unwrap();
    assert_reaped(pid(&first));
}

#[test]
fn idle_watchdog_reaps_expired_and_memory_pressured_workers() {
    for pressure in [false, true] {
        let fixture = Fixture::new();
        let stopping = AtomicBool::new(false);
        let mut resident = None;
        let (work, _) = fixture.work("generate", serde_json::json!({}));
        let output = execute(&mut resident, &work, &stopping).unwrap();
        if pressure {
            fs::write(fixture.root.join("pressure"), "1").unwrap();
        } else {
            resident.as_mut().unwrap().expires_at = Instant::now();
        }
        monitor_idle(&mut resident, &stopping).unwrap();
        assert!(resident.is_none());
        assert_reaped(pid(&output));
    }
}

#[test]
fn other_model_operations_release_the_idle_image_worker_first() {
    let fixture = Fixture::new();
    let stopping = AtomicBool::new(false);
    let mut resident = None;
    let (image, _) = fixture.work("generate", serde_json::json!({}));
    let image = execute(&mut resident, &image, &stopping).unwrap();
    let (video, _) = fixture.work("generate-video", serde_json::json!({}));
    let video = execute(&mut resident, &video, &stopping).unwrap();
    assert_ne!(pid(&image), pid(&video));
    assert!(resident.is_none());
    assert_reaped(pid(&image));
    assert_reaped(pid(&video));
}

#[test]
fn cpu_preprocessing_preserves_the_idle_image_model() {
    let fixture = Fixture::new();
    let preprocessing = Fixture::new();
    let stopping = AtomicBool::new(false);
    let mut resident = None;
    let (image, _) = fixture.work("generate", serde_json::json!({}));
    let image = execute(&mut resident, &image, &stopping).unwrap();
    let expires_at = resident.as_ref().unwrap().expires_at;
    for operation in ["prepare-mask", "image-mask", "mask-composite", "canny"] {
        let (work, _) = preprocessing.work(operation, serde_json::json!({}));
        let result = execute(&mut resident, &work, &stopping).unwrap();
        assert_ne!(pid(&image), pid(&result));
        assert_eq!(expires_at, resident.as_ref().unwrap().expires_at);
    }
    let (again, _) = fixture.work("generate", serde_json::json!({}));
    let again = execute(&mut resident, &again, &stopping).unwrap();
    assert_eq!(pid(&image), pid(&again));
    release(&mut resident).unwrap();
}

#[test]
fn idle_model_expires_while_cpu_preprocessing_is_still_running() {
    let fixture = Fixture::new();
    let stopping = AtomicBool::new(false);
    let mut resident = None;
    let (image, _) = fixture.work("generate", serde_json::json!({}));
    let image = execute(&mut resident, &image, &stopping).unwrap();
    resident.as_mut().unwrap().expires_at = Instant::now() + Duration::from_millis(100);
    let (work, _) = fixture.work("canny", serde_json::json!({"delay":6}));
    let result = execute(&mut resident, &work, &stopping).unwrap();
    assert!(result.status.success());
    assert!(resident.is_none());
    assert_reaped(pid(&image));
}

#[test]
fn failure_crash_and_deadline_release_worker_resources() {
    for request in [
        serde_json::json!({"fail":true}),
        serde_json::json!({"crash":true}),
        serde_json::json!({"delay":30}),
    ] {
        let fixture = Fixture::new();
        let stopping = AtomicBool::new(false);
        let mut resident = None;
        let (initial, _) = fixture.work("generate", serde_json::json!({}));
        let initial = execute(&mut resident, &initial, &stopping).unwrap();
        let (mut work, _) = fixture.work("generate", request.clone());
        work.timeout = Duration::from_millis(200);
        let failure = execute(&mut resident, &work, &stopping).unwrap_err();
        if request.get("fail").is_some() {
            assert!(failure.contains("out of memory"));
        }
        if request.get("delay").is_some() {
            assert!(failure.contains("deadline"));
        }
        assert_reaped(pid(&initial));
        release(&mut resident).unwrap();
    }
}

#[test]
fn cancellation_and_monitor_failures_reap_in_flight_workers() {
    for reason in ["generation was canceled", "database unavailable"] {
        let fixture = Fixture::new();
        let (work, _) = fixture.work("generate", serde_json::json!({}));
        let mut worker = ResidentWorker::spawn(work.process, "test".into()).unwrap();
        let output = worker
            .request("generate", Some(b"{}"), Duration::from_secs(10), |_| Ok(()))
            .unwrap();
        let started = Instant::now();
        let error = worker
            .request(
                "generate",
                Some(b"{\"delay\":30}"),
                Duration::from_secs(10),
                |_| {
                    if started.elapsed() > Duration::from_millis(100) {
                        Err(reason.into())
                    } else {
                        Ok(())
                    }
                },
            )
            .unwrap_err();
        assert!(error.contains(reason));
        assert!(!worker.alive().unwrap());
        assert_reaped(pid(&output));
    }
}

#[test]
fn queued_release_waits_for_active_generation_and_shutdown_reaps_idle_worker() {
    let fixture = Fixture::new();
    let (sender, receiver) = mpsc::channel();
    let stopping = Arc::new(AtomicBool::new(false));
    let worker_stopping = stopping.clone();
    let thread = thread::spawn(move || manage(receiver, &worker_stopping));
    let (work, output) = fixture.work("generate", serde_json::json!({"delay":1}));
    sender.send(Request::Run(work)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fixture.root.join("active").exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    let (released, release_result) = mpsc::sync_channel(1);
    sender.send(Request::Release(released)).unwrap();
    assert!(matches!(
        release_result.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    let output = output
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    release_result
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    assert_reaped(pid(&output));
    let (work, output) = fixture.work("generate", serde_json::json!({}));
    sender.send(Request::Run(work)).unwrap();
    let output = output
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    stopping.store(true, Ordering::Release);
    sender.send(Request::Shutdown).unwrap();
    thread.join().unwrap();
    assert_reaped(pid(&output));
}

#[test]
fn shutdown_interrupts_active_generation_and_reaps_worker() {
    let fixture = Fixture::new();
    let (sender, receiver) = mpsc::channel();
    let stopping = Arc::new(AtomicBool::new(false));
    let worker_stopping = stopping.clone();
    let thread = thread::spawn(move || manage(receiver, &worker_stopping));
    let (work, output) = fixture.work("generate", serde_json::json!({"delay":30}));
    sender.send(Request::Run(work)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fixture.root.join("active").exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    let worker_pid: u32 = fs::read_to_string(fixture.root.join("active"))
        .unwrap()
        .parse()
        .unwrap();
    stopping.store(true, Ordering::Release);
    sender.send(Request::Shutdown).unwrap();
    assert!(output
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap_err()
        .contains("shutting down"));
    thread.join().unwrap();
    assert_reaped(worker_pid);
}
