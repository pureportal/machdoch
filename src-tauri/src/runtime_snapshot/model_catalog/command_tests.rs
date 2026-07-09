use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use super::command::{
    run_agent_cli_command, AGENT_CLI_OUTPUT_CAPTURE_LIMIT_BYTES, AGENT_CLI_OUTPUT_TRUNCATED_MARKER,
};

const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_AGENT_CLI_TEST_CHILD_MODE";
const TEST_DESCENDANT_PID_FILE_ENV: &str = "MACHDOCH_AGENT_CLI_TEST_DESCENDANT_PID_FILE";
const TEST_CHILD_ENTRYPOINT: &str =
    "runtime_snapshot::model_catalog::command_tests::agent_cli_test_child_entrypoint";

#[cfg(target_os = "windows")]
fn large_output_command() -> (PathBuf, Vec<&'static str>, HashMap<String, String>) {
    let (executable, args) = test_child_command();
    let mut env_values = HashMap::new();
    env_values.insert(TEST_CHILD_MODE_ENV.to_string(), "large-output".to_string());

    (executable, args, env_values)
}

#[cfg(target_os = "windows")]
fn nonzero_output_command() -> (PathBuf, Vec<&'static str>, HashMap<String, String>) {
    let (executable, args) = test_child_command();
    let mut env_values = HashMap::new();
    env_values.insert(
        TEST_CHILD_MODE_ENV.to_string(),
        "nonzero-output".to_string(),
    );

    (executable, args, env_values)
}

#[cfg(not(target_os = "windows"))]
fn large_output_command() -> (PathBuf, Vec<&'static str>, HashMap<String, String>) {
    (
        PathBuf::from("/bin/sh"),
        vec![
            "-c",
            "i=0; while [ \"$i\" -lt 256 ]; do head -c 8192 /dev/zero | tr '\\0' x; head -c 8192 /dev/zero | tr '\\0' x >&2; i=$((i + 1)); done",
        ],
        HashMap::new(),
    )
}

#[cfg(not(target_os = "windows"))]
fn nonzero_output_command() -> (PathBuf, Vec<&'static str>, HashMap<String, String>) {
    (
        PathBuf::from("/bin/sh"),
        vec!["-c", "printf stdout-value; printf stderr-value >&2; exit 7"],
        HashMap::new(),
    )
}

fn test_child_command() -> (PathBuf, Vec<&'static str>) {
    (
        env::current_exe().expect("test executable should resolve"),
        vec!["--exact", TEST_CHILD_ENTRYPOINT, "--nocapture"],
    )
}

fn read_descendant_pid(pid_file: &Path) -> u32 {
    fs::read_to_string(pid_file)
        .expect("descendant pid file should be written")
        .trim()
        .parse::<u32>()
        .expect("descendant pid should be numeric")
}

#[cfg(target_os = "windows")]
fn pid_is_running(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    let output = Command::new("tasklist")
        .args(["/FI", filter.as_str(), "/NH"])
        .output()
        .expect("tasklist should run");

    String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
}

#[cfg(not(target_os = "windows"))]
fn pid_is_running(pid: u32) -> bool {
    let pid = pid.to_string();
    Command::new("kill")
        .args(["-0", pid.as_str()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn kill_pid(pid: u32) {
    let pid = pid.to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(not(target_os = "windows"))]
fn kill_pid(pid: u32) {
    let pid = pid.to_string();
    let _ = Command::new("kill")
        .args(["-TERM", pid.as_str()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    let started_at = Instant::now();

    while started_at.elapsed() < timeout {
        if !pid_is_running(pid) {
            return true;
        }

        thread::sleep(Duration::from_millis(25));
    }

    !pid_is_running(pid)
}

#[test]
fn agent_cli_test_child_entrypoint() {
    match env::var(TEST_CHILD_MODE_ENV).as_deref() {
        Ok("spawn-descendant") => {
            let pid_file = env::var(TEST_DESCENDANT_PID_FILE_ENV)
                .expect("descendant pid file should be configured");
            let mut descendant =
                Command::new(env::current_exe().expect("test executable should resolve"));
            descendant
                .arg("--exact")
                .arg(TEST_CHILD_ENTRYPOINT)
                .arg("--nocapture")
                .env(TEST_CHILD_MODE_ENV, "hold-pipes")
                .env(TEST_DESCENDANT_PID_FILE_ENV, &pid_file);

            let descendant = descendant
                .spawn()
                .expect("descendant test process should start");
            fs::write(pid_file, descendant.id().to_string())
                .expect("descendant pid file should be written");
            loop {
                thread::park();
            }
        }
        Ok("hold-pipes") => {
            println!("descendant holding stdout");
            eprintln!("descendant holding stderr");
            loop {
                thread::park();
            }
        }
        Ok("large-output") => {
            let chunk = "x".repeat(8192);

            for _ in 0..256 {
                print!("{chunk}");
                eprint!("{chunk}");
            }
        }
        Ok("nonzero-output") => {
            print!("stdout-value");
            eprint!("stderr-value");
            std::process::exit(7);
        }
        _ => {}
    }
}

#[test]
fn agent_cli_command_drains_large_stdout_and_stderr_while_running() {
    let (executable, args, env_values) = large_output_command();
    let output = run_agent_cli_command(
        &executable,
        args.as_slice(),
        &env_values,
        Duration::from_secs(10),
    )
    .expect("large stdout and stderr should not block child process exit");

    assert_eq!(output.exit_code, Some(0));
    assert!(output.stdout.len() < AGENT_CLI_OUTPUT_CAPTURE_LIMIT_BYTES + 256);
    assert!(output.stderr.len() < AGENT_CLI_OUTPUT_CAPTURE_LIMIT_BYTES + 256);
    assert!(output.stdout.contains(AGENT_CLI_OUTPUT_TRUNCATED_MARKER));
    assert!(output.stderr.contains(AGENT_CLI_OUTPUT_TRUNCATED_MARKER));
    assert!(std::str::from_utf8(output.stdout.as_bytes()).is_ok());
    assert!(std::str::from_utf8(output.stderr.as_bytes()).is_ok());
}

#[test]
fn agent_cli_command_preserves_nonzero_status_stdout_and_stderr() {
    let (executable, args, env_values) = nonzero_output_command();
    let output = run_agent_cli_command(
        &executable,
        args.as_slice(),
        &env_values,
        Duration::from_secs(10),
    )
    .expect("nonzero command output should still be returned");

    assert_eq!(output.exit_code, Some(7));
    assert!(output.stdout.contains("stdout-value"));
    assert!(output.stderr.contains("stderr-value"));
}

#[test]
fn agent_cli_command_timeout_stops_descendant_and_joins_pipe_readers() {
    let (executable, args) = test_child_command();
    let pid_file = env::temp_dir().join(format!(
        "machdoch-agent-cli-descendant-{}.pid",
        std::process::id()
    ));
    let _ = fs::remove_file(&pid_file);
    let mut env_values = HashMap::new();
    env_values.insert(
        TEST_CHILD_MODE_ENV.to_string(),
        "spawn-descendant".to_string(),
    );
    env_values.insert(
        TEST_DESCENDANT_PID_FILE_ENV.to_string(),
        pid_file.display().to_string(),
    );

    let error = match run_agent_cli_command(
        &executable,
        args.as_slice(),
        &env_values,
        Duration::from_millis(1_500),
    ) {
        Ok(_) => panic!("hanging command should time out"),
        Err(error) => error,
    };

    assert!(error.contains("timed out while discovering agent CLI models"));

    let descendant_pid = read_descendant_pid(&pid_file);
    let descendant_exited = wait_for_pid_exit(descendant_pid, Duration::from_secs(3));

    if !descendant_exited {
        kill_pid(descendant_pid);
    }

    let _ = fs::remove_file(pid_file);
    assert!(
        descendant_exited,
        "timeout cleanup should terminate the spawned descendant process"
    );
}
