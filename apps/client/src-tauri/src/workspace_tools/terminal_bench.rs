use std::{
    fs,
    sync::atomic::AtomicUsize,
    time::{Duration, Instant},
};

use super::*;

const OUTPUT_BYTES: usize = 50 * 1024 * 1024;
const THROUGHPUT_RUNS: usize = 3;
const ECHO_SAMPLES: usize = 40;

struct BenchTerminal {
    session: Arc<TerminalSession>,
    sessions: TerminalSessions,
    output: Arc<Mutex<Vec<u8>>>,
    received: Arc<AtomicUsize>,
    workspace: PathBuf,
}

impl BenchTerminal {
    fn start() -> Option<Self> {
        let shells = discover_shell_specs();
        let preferred_id = if cfg!(windows) { "cmd" } else { "sh" };
        let shell = shells
            .iter()
            .find(|shell| shell.id == preferred_id)?
            .clone();
        let workspace = env::temp_dir().join(format!(
            "machdoch-terminal-bench-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&workspace).expect("bench workspace should create");
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let received = Arc::new(AtomicUsize::new(0));
        let acknowledged_sessions = Arc::clone(&sessions);
        let callback_output = Arc::clone(&output);
        let callback_received = Arc::clone(&received);
        let channel = Channel::<WorkspaceTerminalEvent>::new(move |body| {
            if let WorkspaceTerminalEvent::Output { session_id, data } =
                body.deserialize::<WorkspaceTerminalEvent>()?
            {
                let bytes = BASE64_STANDARD
                    .decode(data)
                    .map_err(|error| tauri::Error::Anyhow(error.into()))?;
                callback_received.fetch_add(bytes.len(), Ordering::SeqCst);
                let mut output = callback_output.lock().expect("bench output should lock");
                output.extend(&bytes);
                let excess = output.len().saturating_sub(64 * 1024);
                output.drain(..excess);
                drop(output);
                if let Some(session) = acknowledged_sessions
                    .lock()
                    .ok()
                    .and_then(|registry| registry.get(&session_id).cloned())
                {
                    session.output_flow.acknowledge_output(bytes.len());
                }
            }
            Ok(())
        });
        let started = start_terminal_sync(
            Arc::clone(&sessions),
            StartWorkspaceTerminalRequest {
                workspace_root: workspace.to_string_lossy().into_owned(),
                shell_id: shell.id,
                columns: 120,
                rows: 40,
                cwd: None,
            },
            channel,
        )
        .expect("bench terminal should start");
        let session = sessions
            .lock()
            .expect("bench registry should lock")
            .get(&started.session_id)
            .cloned()
            .expect("bench session should be registered");
        let terminal = Self {
            session,
            sessions,
            output,
            received,
            workspace,
        };
        terminal.answer_status_query();
        Some(terminal)
    }

    fn answer_status_query(&self) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && !self.contains(b"\x1b[6n") {
            thread::sleep(Duration::from_millis(10));
        }
        if self.contains(b"\x1b[6n") {
            self.write(b"\x1b[1;1R");
            thread::sleep(Duration::from_millis(200));
        }
    }

    fn contains(&self, needle: &[u8]) -> bool {
        self.output
            .lock()
            .expect("bench output should lock")
            .windows(needle.len())
            .any(|window| window == needle)
    }

    fn write(&self, bytes: &[u8]) {
        let mut writer = self
            .session
            .writer
            .lock()
            .expect("bench writer should lock");
        let writer = writer.as_mut().expect("bench writer should be open");
        writer.write_all(bytes).expect("bench input should write");
        writer.flush().expect("bench input should flush");
    }

    fn wait_for(&self, needle: &[u8], timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.contains(needle) {
                return true;
            }
            thread::sleep(Duration::from_millis(1));
        }
        false
    }

    fn clear(&self) {
        self.output
            .lock()
            .expect("bench output should lock")
            .clear();
    }
}

impl Drop for BenchTerminal {
    fn drop(&mut self) {
        let _ = self.session.stop();
        self.sessions
            .lock()
            .expect("bench registry should lock")
            .clear();
        let _ = fs::remove_dir_all(&self.workspace);
    }
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn measurement(name: &str, mut samples: Vec<f64>) -> serde_json::Value {
    let unsorted = samples.clone();
    samples.sort_by(f64::total_cmp);
    serde_json::json!({
        "name": name,
        "fixture": "—",
        "temperature": "warm",
        "samples": unsorted,
        "p50": percentile(&samples, 0.5),
        "p95": percentile(&samples, 0.95),
    })
}

fn measure_throughput(terminal: &BenchTerminal) -> Vec<f64> {
    let script = format!(
        "node -e \"const c=Buffer.alloc(65536,121);for(let i=0;i<{};i++)process.stdout.write(c);process.stdout.write('\\nMACHDOCH_BENCH_'+'DONE\\n')\"{}",
        OUTPUT_BYTES / 65536,
        if cfg!(windows) { "\r" } else { "\n" }
    );
    (0..THROUGHPUT_RUNS)
        .map(|_| {
            terminal.clear();
            let before = terminal.received.load(Ordering::SeqCst);
            let started = Instant::now();
            terminal.write(script.as_bytes());
            assert!(
                terminal.wait_for(b"MACHDOCH_BENCH_DONE", Duration::from_secs(300)),
                "the 50 MB output did not finish"
            );
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            assert!(terminal.received.load(Ordering::SeqCst) - before >= OUTPUT_BYTES / 2);
            elapsed
        })
        .collect()
}

fn measure_echo(terminal: &BenchTerminal) -> Vec<f64> {
    let mut samples = Vec::with_capacity(ECHO_SAMPLES);
    for index in 0..ECHO_SAMPLES {
        let marker = format!("Q{index:02}");
        terminal.clear();
        let started = Instant::now();
        terminal.write(marker.as_bytes());
        assert!(
            terminal.wait_for(marker.as_bytes(), Duration::from_secs(5)),
            "typed input was not echoed"
        );
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        terminal.write(b"\x08\x08\x08");
        thread::sleep(Duration::from_millis(30));
    }
    samples
}

#[test]
#[ignore = "run through scripts/bench-workspace-git.mjs"]
fn workspace_terminal_benchmark() {
    let output_path = env::var("MACHDOCH_TERMINAL_BENCH_OUTPUT")
        .expect("MACHDOCH_TERMINAL_BENCH_OUTPUT should point to the result file");
    let terminal = BenchTerminal::start().expect("a default shell should be available");
    let echo = measure_echo(&terminal);
    let throughput = measure_throughput(&terminal);
    fs::write(
        output_path,
        serde_json::to_string_pretty(&vec![
            measurement("terminal 50 MB output", throughput),
            measurement("terminal input echo", echo),
        ])
        .expect("terminal measurements should serialize"),
    )
    .expect("terminal measurements should write");
}
