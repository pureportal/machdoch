use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(super) struct AgentCliCommandOutput {
    pub(super) exit_code: Option<i32>,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

fn read_agent_cli_stream(mut stream: impl Read, description: &str) -> Result<String, String> {
    let mut output = String::new();
    stream
        .read_to_string(&mut output)
        .map_err(|error| format!("Failed to read agent CLI {description}: {error}"))?;

    Ok(output)
}

fn join_agent_cli_stream_worker(
    handle: thread::JoinHandle<Result<String, String>>,
    description: &str,
) -> Result<String, String> {
    match handle.join() {
        Ok(result) => result,
        Err(_) => Err(format!(
            "The agent CLI {description} reader terminated unexpectedly."
        )),
    }
}

fn join_agent_cli_output(
    stdout_worker: thread::JoinHandle<Result<String, String>>,
    stderr_worker: thread::JoinHandle<Result<String, String>>,
) -> Result<(String, String), String> {
    let stdout = join_agent_cli_stream_worker(stdout_worker, "stdout")?;
    let stderr = join_agent_cli_stream_worker(stderr_worker, "stderr")?;

    Ok((stdout, stderr))
}

fn terminate_agent_cli_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let taskkill_result = Command::new("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();

        if taskkill_result
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return;
        }
    }

    #[cfg(unix)]
    {
        let process_group_id = format!("-{}", child.id());
        let kill_result = Command::new("kill")
            .args(["-TERM", process_group_id.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        if kill_result.map(|status| status.success()).unwrap_or(false) {
            return;
        }
    }

    let _ = child.kill();
}

pub(super) fn run_agent_cli_command(
    executable: &Path,
    args: &[&str],
    env_values: &HashMap<String, String>,
    timeout: Duration,
) -> Result<AgentCliCommandOutput, String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .envs(env_values)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {}: {error}", executable.display()))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_agent_cli_process_tree(&mut child);
            let _ = child.wait();
            return Err(format!(
                "{} did not expose a stdout stream for agent CLI model discovery.",
                executable.display()
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_agent_cli_process_tree(&mut child);
            let _ = child.wait();
            return Err(format!(
                "{} did not expose a stderr stream for agent CLI model discovery.",
                executable.display()
            ));
        }
    };
    let stdout_worker = thread::spawn(move || read_agent_cli_stream(stdout, "stdout"));
    let stderr_worker = thread::spawn(move || read_agent_cli_stream(stderr, "stderr"));
    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started_at.elapsed() >= timeout => {
                terminate_agent_cli_process_tree(&mut child);
                let _ = child.wait();
                let _ = join_agent_cli_output(stdout_worker, stderr_worker);
                return Err(format!(
                    "{} timed out while discovering agent CLI models.",
                    executable.display()
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                return Err(format!(
                    "Failed while waiting for {}: {error}",
                    executable.display()
                ));
            }
        }
    };
    let (stdout, stderr) = join_agent_cli_output(stdout_worker, stderr_worker)?;

    Ok(AgentCliCommandOutput {
        exit_code: status.code(),
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        env, fs,
        path::{Path, PathBuf},
        process::Command,
        thread,
        time::{Duration, Instant},
    };

    use super::run_agent_cli_command;

    const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_AGENT_CLI_TEST_CHILD_MODE";
    const TEST_DESCENDANT_PID_FILE_ENV: &str = "MACHDOCH_AGENT_CLI_TEST_DESCENDANT_PID_FILE";

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
                "i=0; while [ \"$i\" -lt 128 ]; do head -c 8192 /dev/zero | tr '\\0' x; head -c 8192 /dev/zero | tr '\\0' x >&2; i=$((i + 1)); done",
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
            vec![
                "--exact",
                "runtime_snapshot::model_catalog::command::tests::agent_cli_test_child_entrypoint",
                "--nocapture",
            ],
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
                let mut descendant = Command::new(
                    env::current_exe().expect("test executable should resolve for descendant"),
                );
                descendant
                    .arg("--exact")
                    .arg(
                        "runtime_snapshot::model_catalog::command::tests::agent_cli_test_child_entrypoint",
                    )
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

                for _ in 0..128 {
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
        assert!(output.stdout.len() >= 8192 * 128);
        assert!(output.stderr.len() >= 8192 * 128);
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
}
