use std::{
    fs::{self, OpenOptions},
    io,
    path::Path,
    process::{Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::Value;

use crate::{
    child_process::{SupervisedChild, SupervisedChildSpawnError},
    runtime_snapshot::{get_user_config_directory, resolve_workspace_root_path},
};

use super::{
    diagnostics::{format_command_failure, format_diagnostic_snippet, format_timeout_duration},
    payload::cleanup_temporary_files,
    payload_files::{
        rewrite_instruction_payload_arguments, rewrite_task_interview_payload_arguments,
    },
    process::{
        create_desktop_task_activity, hide_child_process_window, read_bounded_stream_text,
        read_bounded_stream_text_with_limit, read_stderr, SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES,
        SUBPROCESS_OUTPUT_TRUNCATED_MARKER,
    },
    registry::normalize_task_id,
    InstructionCommandRequest, McpCommandRequest, ProviderSyncCommandRequest,
    SchedulerCommandRequest, TaskInterviewCommandRequest, AUXILIARY_CLI_COMMAND_TIMEOUT_MS,
    DESKTOP_TASK_WAIT_POLL_MS,
};

#[cfg(target_os = "windows")]
use super::process::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

#[derive(Debug)]
struct AuxiliaryCliOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

struct AuxiliaryCliSpec {
    subcommand: &'static str,
    command_name: &'static str,
    parse_name: &'static str,
    failure_name: &'static str,
    stdout_capture_limit_bytes: usize,
}

struct AuxiliaryCliProgressContext {
    app_handle: tauri::AppHandle,
    window_label: String,
    task_id: Option<String>,
}

#[derive(Clone, Copy)]
enum AuxiliaryCliProcessMode {
    Supervised,
    PreserveDetachedDescendants,
}

// The persisted library is bounded at 64 MiB. Overview responses add hashes,
// counts, and JSON formatting, so retain a bounded 2x allowance for the
// desktop editor while other auxiliary commands keep the 1 MiB default.
const INSTRUCTION_CLI_OUTPUT_CAPTURE_LIMIT_BYTES: usize = 128 * 1024 * 1024;
const SCHEDULER_SERVICE_OWNER_FRESHNESS: Duration = Duration::from_secs(120);
const SCHEDULER_SERVICE_MODE: &str = "service-all";

const SCHEDULER_CLI_SPEC: AuxiliaryCliSpec = AuxiliaryCliSpec {
    subcommand: "scheduler",
    command_name: "scheduler",
    parse_name: "scheduler",
    failure_name: "scheduler",
    stdout_capture_limit_bytes: SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES,
};

const MCP_CLI_SPEC: AuxiliaryCliSpec = AuxiliaryCliSpec {
    subcommand: "mcp",
    command_name: "MCP",
    parse_name: "MCP",
    failure_name: "MCP",
    stdout_capture_limit_bytes: SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES,
};

const PROVIDER_SYNC_CLI_SPEC: AuxiliaryCliSpec = AuxiliaryCliSpec {
    subcommand: "provider-sync",
    command_name: "provider sync",
    parse_name: "provider sync",
    failure_name: "provider sync",
    stdout_capture_limit_bytes: SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES,
};

const INSTRUCTION_CLI_SPEC: AuxiliaryCliSpec = AuxiliaryCliSpec {
    subcommand: "instructions",
    command_name: "instruction",
    parse_name: "instruction",
    failure_name: "instruction",
    stdout_capture_limit_bytes: INSTRUCTION_CLI_OUTPUT_CAPTURE_LIMIT_BYTES,
};

const TASK_INTERVIEW_CLI_SPEC: AuxiliaryCliSpec = AuxiliaryCliSpec {
    subcommand: "interview",
    command_name: "task interview",
    parse_name: "task interview",
    failure_name: "task interview",
    stdout_capture_limit_bytes: SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES,
};

#[derive(Debug, PartialEq, Eq)]
enum SchedulerServiceOwnerClassification {
    Missing,
    Malformed,
    Stale,
    Dead,
    NonScheduler,
    Reusable(u32),
}

#[derive(Debug, PartialEq, Eq)]
enum SchedulerServiceStartDecision {
    LaunchReplacement,
    Reuse(u32),
}

trait SchedulerProcessInspector {
    fn command_line(&self, pid: u32) -> Option<Vec<String>>;
}

struct SystemSchedulerProcessInspector;

impl SchedulerProcessInspector for SystemSchedulerProcessInspector {
    fn command_line(&self, pid: u32) -> Option<Vec<String>> {
        if pid == 0 {
            return None;
        }

        let pid = Pid::from_u32(pid);
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
        );

        system.process(pid).map(|process| {
            process
                .cmd()
                .iter()
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect()
        })
    }
}

fn scheduler_owner_pid(owner: &str) -> Option<u32> {
    let (pid, issued_at) = owner.trim().split_once(':')?;
    let pid = pid.parse::<u32>().ok()?;

    (pid > 0 && issued_at.parse::<u64>().is_ok()).then_some(pid)
}

fn is_scheduler_service_command(command_line: &[String]) -> bool {
    command_line.windows(5).any(|arguments| {
        arguments[0] == "--json"
            && arguments[1] == "--cwd"
            && !arguments[2].is_empty()
            && arguments[3] == SCHEDULER_CLI_SPEC.subcommand
            && arguments[4] == SCHEDULER_SERVICE_MODE
    })
}

fn classify_scheduler_service_owner(
    owner: Option<&str>,
    age: Option<Duration>,
    process_inspector: &impl SchedulerProcessInspector,
) -> SchedulerServiceOwnerClassification {
    let Some(pid) = owner.and_then(scheduler_owner_pid) else {
        return if owner.is_some() {
            SchedulerServiceOwnerClassification::Malformed
        } else {
            SchedulerServiceOwnerClassification::Missing
        };
    };

    if age.is_none_or(|age| age > SCHEDULER_SERVICE_OWNER_FRESHNESS) {
        return SchedulerServiceOwnerClassification::Stale;
    }

    let Some(command_line) = process_inspector.command_line(pid) else {
        return SchedulerServiceOwnerClassification::Dead;
    };

    if is_scheduler_service_command(&command_line) {
        SchedulerServiceOwnerClassification::Reusable(pid)
    } else {
        SchedulerServiceOwnerClassification::NonScheduler
    }
}

fn scheduler_service_start_decision(
    owner: Option<&str>,
    age: Option<Duration>,
    process_inspector: &impl SchedulerProcessInspector,
) -> SchedulerServiceStartDecision {
    match classify_scheduler_service_owner(owner, age, process_inspector) {
        SchedulerServiceOwnerClassification::Reusable(pid) => {
            SchedulerServiceStartDecision::Reuse(pid)
        }
        SchedulerServiceOwnerClassification::Missing
        | SchedulerServiceOwnerClassification::Malformed
        | SchedulerServiceOwnerClassification::Stale
        | SchedulerServiceOwnerClassification::Dead
        | SchedulerServiceOwnerClassification::NonScheduler => {
            SchedulerServiceStartDecision::LaunchReplacement
        }
    }
}

fn scheduler_service_owner_age(owner_path: &Path) -> Option<Duration> {
    fs::metadata(owner_path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
}

fn clear_scheduler_service_owner(owner_path: &Path) -> Result<(), String> {
    let Some(lock_path) = owner_path.parent() else {
        return Ok(());
    };

    match fs::remove_dir_all(lock_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to clear unusable scheduler service ownership: {error}"
        )),
    }
}

fn recover_scheduler_service_owner(
    owner_path: &Path,
    process_inspector: &impl SchedulerProcessInspector,
) -> Result<SchedulerServiceStartDecision, String> {
    let owner = fs::read_to_string(owner_path).ok();
    let owner_exists = owner_path.exists();
    let decision = scheduler_service_start_decision(
        owner.as_deref(),
        scheduler_service_owner_age(owner_path),
        process_inspector,
    );

    if owner_exists && decision == SchedulerServiceStartDecision::LaunchReplacement {
        clear_scheduler_service_owner(owner_path)?;
    }

    Ok(decision)
}

fn join_auxiliary_cli_output(
    stdout_worker: thread::JoinHandle<Result<String, String>>,
    stderr_worker: thread::JoinHandle<Result<String, String>>,
) -> Result<(String, String), String> {
    let stdout_text = stdout_worker
        .join()
        .map_err(|_| "The shared CLI stdout worker terminated unexpectedly.".to_string())??;
    let stderr_text = stderr_worker
        .join()
        .map_err(|_| "The shared CLI stderr worker terminated unexpectedly.".to_string())??;

    Ok((stdout_text, stderr_text))
}

fn stop_auxiliary_cli_after_wait_error(
    error: io::Error,
    child: &mut SupervisedChild,
    stdout_worker: thread::JoinHandle<Result<String, String>>,
    stderr_worker: thread::JoinHandle<Result<String, String>>,
    command_name: &str,
) -> String {
    let _ = child.terminate_and_reap();

    let cleanup_result = join_auxiliary_cli_output(stdout_worker, stderr_worker);
    let message = format!("Failed to wait for the {command_name} CLI to finish: {error}");

    match cleanup_result {
        Ok(_) => message,
        Err(cleanup_error) => {
            format!("{message}. Additionally failed to collect {command_name} CLI output during cleanup: {cleanup_error}")
        }
    }
}

fn run_bounded_auxiliary_cli_command(
    command: &mut Command,
    command_name: &str,
    timeout_ms: Option<u64>,
    progress_context: Option<AuxiliaryCliProgressContext>,
    stdout_capture_limit_bytes: usize,
    process_mode: AuxiliaryCliProcessMode,
) -> Result<AuxiliaryCliOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_child_process_window(command);

    let child = match process_mode {
        AuxiliaryCliProcessMode::Supervised => SupervisedChild::spawn(command),
        AuxiliaryCliProcessMode::PreserveDetachedDescendants => {
            SupervisedChild::spawn_preserving_descendants_after_exit(command)
        }
    };
    let mut child = child.map_err(|error| match error {
        SupervisedChildSpawnError::Spawn(error) => format!(
            "Failed to launch the {command_name} CLI. {} {error}",
            crate::shared_cli::cli_runtime_error_hint()
        ),
        SupervisedChildSpawnError::Isolation(error) => error,
    })?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.terminate_and_reap();
            return Err(format!(
                "The {command_name} CLI did not expose a stdout stream."
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.terminate_and_reap();
            return Err(format!(
                "The {command_name} CLI did not expose a stderr stream."
            ));
        }
    };

    let stdout_worker = thread::spawn(move || {
        read_bounded_stream_text_with_limit(stdout, "stdout", stdout_capture_limit_bytes)
    });
    let stderr_worker = match progress_context {
        Some(context) => {
            let activity = create_desktop_task_activity();

            thread::spawn(move || {
                read_stderr(
                    stderr,
                    context.app_handle,
                    context.window_label,
                    context.task_id,
                    activity,
                )
                .map(|lines| lines.join("\n"))
            })
        }
        None => thread::spawn(move || read_bounded_stream_text(stderr, "stderr")),
    };
    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Err(error) => {
                return Err(stop_auxiliary_cli_after_wait_error(
                    error,
                    &mut child,
                    stdout_worker,
                    stderr_worker,
                    command_name,
                ));
            }
            Ok(None) => {
                if timeout_ms
                    .map(|timeout_ms| started_at.elapsed() >= Duration::from_millis(timeout_ms))
                    .unwrap_or(false)
                {
                    let _ = child.terminate_and_reap();

                    let (stdout_text, stderr_text) =
                        join_auxiliary_cli_output(stdout_worker, stderr_worker)?;
                    let failure_tail = format_command_failure(&stderr_text, &stdout_text);
                    let timeout_ms = timeout_ms.unwrap_or_default();

                    return Err(format!(
                        "The {command_name} CLI exceeded the desktop safety timeout of {} and was stopped. {}",
                        format_timeout_duration(timeout_ms),
                        failure_tail
                    ));
                }

                thread::sleep(Duration::from_millis(DESKTOP_TASK_WAIT_POLL_MS));
            }
        }
    };
    let (stdout, stderr) = join_auxiliary_cli_output(stdout_worker, stderr_worker)?;

    Ok(AuxiliaryCliOutput {
        status,
        stdout,
        stderr,
    })
}

fn build_auxiliary_cli_args(
    workspace_root: &str,
    subcommand: &str,
    arguments: impl IntoIterator<Item = String>,
) -> Result<Vec<String>, String> {
    let workspace_path = resolve_workspace_root_path(workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        subcommand.to_string(),
    ];

    append_auxiliary_arguments(&mut cli_args, arguments);

    Ok(cli_args)
}

fn append_auxiliary_arguments(
    cli_args: &mut Vec<String>,
    arguments: impl IntoIterator<Item = String>,
) {
    cli_args.extend(arguments);
}

fn parse_auxiliary_command_response(stdout: &str, parse_name: &str) -> Result<Value, String> {
    if stdout.contains(SUBPROCESS_OUTPUT_TRUNCATED_MARKER) {
        return Err(format!(
            "The {parse_name} CLI response exceeded its bounded desktop output limit. No partial response was accepted."
        ));
    }
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the {parse_name} CLI JSON response: {error}. Output: {}",
            format_diagnostic_snippet(trimmed_stdout)
        )
    })
}

fn finish_auxiliary_command_response(
    output: AuxiliaryCliOutput,
    spec: &AuxiliaryCliSpec,
) -> Result<Value, String> {
    let stdout_text = output.stdout;
    let stderr_text = output.stderr;

    if !output.status.success() {
        return Err(format!(
            "The {} CLI command failed. {}",
            spec.failure_name,
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_auxiliary_command_response(&stdout_text, spec.parse_name)
}

fn run_auxiliary_json_command_with_process_mode(
    workspace_root: &str,
    arguments: impl IntoIterator<Item = String>,
    spec: &AuxiliaryCliSpec,
    process_mode: AuxiliaryCliProcessMode,
) -> Result<Value, String> {
    let cli_args = build_auxiliary_cli_args(workspace_root, spec.subcommand, arguments)?;
    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;
    let output = run_bounded_auxiliary_cli_command(
        &mut cli_command.command,
        spec.command_name,
        Some(AUXILIARY_CLI_COMMAND_TIMEOUT_MS),
        None,
        spec.stdout_capture_limit_bytes,
        process_mode,
    )?;

    finish_auxiliary_command_response(output, spec)
}

fn run_auxiliary_json_command(
    workspace_root: &str,
    arguments: impl IntoIterator<Item = String>,
    spec: &AuxiliaryCliSpec,
) -> Result<Value, String> {
    run_auxiliary_json_command_with_process_mode(
        workspace_root,
        arguments,
        spec,
        AuxiliaryCliProcessMode::Supervised,
    )
}

pub(super) fn execute_scheduler_command(request: SchedulerCommandRequest) -> Result<Value, String> {
    run_auxiliary_json_command(
        &request.workspace_root,
        request.arguments,
        &SCHEDULER_CLI_SPEC,
    )
}

pub(super) fn start_scheduler_service(request: SchedulerCommandRequest) -> Result<u32, String> {
    let user_config_directory = get_user_config_directory()?;
    fs::create_dir_all(&user_config_directory)
        .map_err(|error| format!("Failed to create the scheduler service directory: {error}"))?;
    let service_owner_path = user_config_directory
        .join("scheduler-workspaces.json.service-lock")
        .join("owner");
    match recover_scheduler_service_owner(&service_owner_path, &SystemSchedulerProcessInspector)? {
        SchedulerServiceStartDecision::Reuse(pid) => return Ok(pid),
        SchedulerServiceStartDecision::LaunchReplacement => {}
    }
    let workspace_path = if request.workspace_root.trim().is_empty() {
        user_config_directory.clone()
    } else {
        resolve_workspace_root_path(&request.workspace_root)?
    };
    let log_path = user_config_directory.join("scheduler-service.log");
    if fs::metadata(&log_path)
        .map(|metadata| metadata.len() > 10 * 1024 * 1024)
        .unwrap_or(false)
    {
        let rotated_log_path = user_config_directory.join("scheduler-service.log.1");
        let _ = fs::remove_file(&rotated_log_path);
        fs::rename(&log_path, &rotated_log_path)
            .map_err(|error| format!("Failed to rotate scheduler service log: {error}"))?;
    }
    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Failed to open scheduler service log: {error}"))?;
    let stderr_log = stdout_log
        .try_clone()
        .map_err(|error| format!("Failed to clone scheduler service log handle: {error}"))?;
    let cli_args = build_auxiliary_cli_args(
        &workspace_path.display().to_string(),
        SCHEDULER_CLI_SPEC.subcommand,
        request.arguments,
    )?;
    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;
    cli_command
        .command
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));
    hide_child_process_window(&mut cli_command.command);

    #[cfg(target_os = "windows")]
    {
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cli_command
            .command
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }

    #[cfg(unix)]
    {
        cli_command.command.process_group(0);
    }

    cli_command
        .command
        .spawn()
        .map(|child| child.id())
        .map_err(|error| {
            format!(
                "Failed to launch the persistent scheduler service. {} {error}",
                crate::shared_cli::cli_runtime_error_hint()
            )
        })
}

pub(super) fn execute_mcp_command(request: McpCommandRequest) -> Result<Value, String> {
    run_auxiliary_json_command(&request.workspace_root, request.arguments, &MCP_CLI_SPEC)
}

pub(super) fn execute_provider_sync_command(
    request: ProviderSyncCommandRequest,
) -> Result<Value, String> {
    let preserve_daemon = request
        .arguments
        .first()
        .is_some_and(|action| action == "enable" || action == "refresh");
    run_auxiliary_json_command_with_process_mode(
        &request.workspace_root,
        request.arguments,
        &PROVIDER_SYNC_CLI_SPEC,
        if preserve_daemon {
            AuxiliaryCliProcessMode::PreserveDetachedDescendants
        } else {
            AuxiliaryCliProcessMode::Supervised
        },
    )
}

pub(super) fn execute_instruction_command(
    request: InstructionCommandRequest,
) -> Result<Value, String> {
    let (arguments, payload_paths) = rewrite_instruction_payload_arguments(request.arguments)?;
    let result =
        run_auxiliary_json_command(&request.workspace_root, arguments, &INSTRUCTION_CLI_SPEC);
    cleanup_temporary_files(&payload_paths);
    result
}

pub(super) fn execute_task_interview_command(
    app_handle: tauri::AppHandle,
    window_label: String,
    request: TaskInterviewCommandRequest,
) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let task_id = normalize_task_id(request.task_id.as_deref());
    let (arguments, payload_paths) =
        rewrite_task_interview_payload_arguments(&normalized_workspace_root, request.arguments)?;
    let mut cli_args = vec![
        "--json".to_string(),
        "--verbose".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        TASK_INTERVIEW_CLI_SPEC.subcommand.to_string(),
    ];
    append_auxiliary_arguments(&mut cli_args, arguments);

    let mut cli_command = match crate::shared_cli::create_shared_cli_command(&cli_args) {
        Ok(command) => command,
        Err(error) => {
            cleanup_temporary_files(&payload_paths);
            return Err(error);
        }
    };

    let output = match run_bounded_auxiliary_cli_command(
        &mut cli_command.command,
        TASK_INTERVIEW_CLI_SPEC.command_name,
        None,
        Some(AuxiliaryCliProgressContext {
            app_handle,
            window_label,
            task_id,
        }),
        TASK_INTERVIEW_CLI_SPEC.stdout_capture_limit_bytes,
        AuxiliaryCliProcessMode::Supervised,
    ) {
        Ok(output) => output,
        Err(error) => {
            cleanup_temporary_files(&payload_paths);
            return Err(error);
        }
    };
    cleanup_temporary_files(&payload_paths);

    finish_auxiliary_command_response(output, &TASK_INTERVIEW_CLI_SPEC)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        env, fs,
        process::Command,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use super::{
        append_auxiliary_arguments, classify_scheduler_service_owner,
        parse_auxiliary_command_response, recover_scheduler_service_owner,
        run_bounded_auxiliary_cli_command, scheduler_service_start_decision,
        AuxiliaryCliProcessMode, SchedulerProcessInspector, SchedulerServiceOwnerClassification,
        SchedulerServiceStartDecision, INSTRUCTION_CLI_SPEC,
    };
    use crate::desktop_task::diagnostics::COMMAND_DIAGNOSTIC_TRUNCATED_MARKER;
    use crate::desktop_task::process::{
        SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES, SUBPROCESS_OUTPUT_TRUNCATED_MARKER,
    };

    const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_AUXILIARY_CLI_TEST_CHILD_MODE";

    #[derive(Default)]
    struct TestSchedulerProcessInspector {
        command_lines: HashMap<u32, Vec<String>>,
    }

    impl TestSchedulerProcessInspector {
        fn with_process(pid: u32, command_line: &[&str]) -> Self {
            Self {
                command_lines: HashMap::from([(
                    pid,
                    command_line
                        .iter()
                        .map(|argument| (*argument).to_string())
                        .collect(),
                )]),
            }
        }
    }

    impl SchedulerProcessInspector for TestSchedulerProcessInspector {
        fn command_line(&self, pid: u32) -> Option<Vec<String>> {
            self.command_lines.get(&pid).cloned()
        }
    }

    fn fresh_scheduler_service_command() -> [&'static str; 6] {
        [
            "cli-entry.js",
            "--json",
            "--cwd",
            "C:\\workspace",
            "scheduler",
            "service-all",
        ]
    }

    #[test]
    fn scheduler_owner_classification_rejects_malformed_records() {
        let classification = classify_scheduler_service_owner(
            Some("not-a-pid"),
            Some(Duration::ZERO),
            &TestSchedulerProcessInspector::default(),
        );

        assert_eq!(
            classification,
            SchedulerServiceOwnerClassification::Malformed
        );
    }

    #[test]
    fn scheduler_owner_classification_rejects_stale_records() {
        let classification = classify_scheduler_service_owner(
            Some("17:123"),
            Some(Duration::from_secs(121)),
            &TestSchedulerProcessInspector::with_process(17, &fresh_scheduler_service_command()),
        );

        assert_eq!(classification, SchedulerServiceOwnerClassification::Stale);
    }

    #[test]
    fn scheduler_owner_classification_rejects_fresh_dead_processes() {
        let classification = classify_scheduler_service_owner(
            Some("17:123"),
            Some(Duration::ZERO),
            &TestSchedulerProcessInspector::default(),
        );

        assert_eq!(classification, SchedulerServiceOwnerClassification::Dead);
    }

    #[test]
    fn scheduler_owner_classification_reuses_a_live_scheduler_process() {
        let classification = classify_scheduler_service_owner(
            Some("17:123"),
            Some(Duration::ZERO),
            &TestSchedulerProcessInspector::with_process(17, &fresh_scheduler_service_command()),
        );

        assert_eq!(
            classification,
            SchedulerServiceOwnerClassification::Reusable(17)
        );
    }

    #[test]
    fn scheduler_owner_classification_rejects_live_non_scheduler_processes() {
        let classification = classify_scheduler_service_owner(
            Some("17:123"),
            Some(Duration::ZERO),
            &TestSchedulerProcessInspector::with_process(17, &["node", "server.js"]),
        );

        assert_eq!(
            classification,
            SchedulerServiceOwnerClassification::NonScheduler
        );
    }

    #[test]
    fn scheduler_owner_classification_rejects_live_non_service_scheduler_processes() {
        let process_inspector = TestSchedulerProcessInspector::with_process(
            17,
            &[
                "cli-entry.js",
                "--json",
                "--cwd",
                "C:\\workspace",
                "scheduler",
                "run-due",
            ],
        );
        let classification = classify_scheduler_service_owner(
            Some("17:123"),
            Some(Duration::ZERO),
            &process_inspector,
        );
        let decision = scheduler_service_start_decision(
            Some("17:123"),
            Some(Duration::ZERO),
            &process_inspector,
        );

        assert_eq!(
            classification,
            SchedulerServiceOwnerClassification::NonScheduler
        );
        assert_eq!(decision, SchedulerServiceStartDecision::LaunchReplacement);
    }

    #[test]
    fn scheduler_service_start_decision_replaces_dead_owners_and_reuses_live_owners() {
        let replacement = scheduler_service_start_decision(
            Some("17:123"),
            Some(Duration::ZERO),
            &TestSchedulerProcessInspector::default(),
        );
        let reuse = scheduler_service_start_decision(
            Some("17:123"),
            Some(Duration::ZERO),
            &TestSchedulerProcessInspector::with_process(17, &fresh_scheduler_service_command()),
        );

        assert_eq!(
            replacement,
            SchedulerServiceStartDecision::LaunchReplacement
        );
        assert_eq!(reuse, SchedulerServiceStartDecision::Reuse(17));
    }

    #[test]
    fn scheduler_owner_recovery_clears_a_fresh_dead_owner_before_replacement() {
        let test_directory = env::temp_dir().join(format!(
            "machdoch-scheduler-owner-recovery-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time should be after the Unix epoch")
                .as_nanos(),
        ));
        let lock_path = test_directory.join("scheduler-workspaces.json.service-lock");
        let owner_path = lock_path.join("owner");
        fs::create_dir_all(&lock_path).expect("scheduler lock directory should be created");
        fs::write(&owner_path, "17:123").expect("dead scheduler owner should be recorded");

        let decision =
            recover_scheduler_service_owner(&owner_path, &TestSchedulerProcessInspector::default())
                .expect("dead scheduler owner should be recovered");

        assert_eq!(decision, SchedulerServiceStartDecision::LaunchReplacement);
        assert!(!lock_path.exists());

        fs::remove_dir_all(test_directory).expect("test directory should be removed");
    }

    #[test]
    fn auxiliary_arguments_preserve_empty_and_whitespace_values() {
        let mut arguments = vec!["instructions".to_string()];
        append_auxiliary_arguments(
            &mut arguments,
            [
                "--description".to_string(),
                "".to_string(),
                "  spaced value  ".to_string(),
            ],
        );

        assert_eq!(
            arguments,
            ["instructions", "--description", "", "  spaced value  "]
        );
    }

    #[test]
    fn instruction_cli_retains_large_but_bounded_library_responses() {
        const {
            assert!(
                INSTRUCTION_CLI_SPEC.stdout_capture_limit_bytes
                    > SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES
            );
        }
        assert_eq!(
            INSTRUCTION_CLI_SPEC.stdout_capture_limit_bytes,
            128 * 1024 * 1024
        );
    }

    fn test_child_command(mode: &str) -> Command {
        let mut command = Command::new(env::current_exe().expect("test executable should resolve"));

        command
            .arg("--exact")
            .arg("desktop_task::cli_commands::tests::auxiliary_cli_test_child_entrypoint")
            .arg("--nocapture")
            .env(TEST_CHILD_MODE_ENV, mode);

        command
    }

    #[test]
    fn auxiliary_cli_test_child_entrypoint() {
        match env::var(TEST_CHILD_MODE_ENV).as_deref() {
            Ok("json") => {
                println!(r#"{{"ok":true}}"#);
                eprintln!("child stderr");
            }
            Ok("hang") => thread::sleep(Duration::from_secs(60)),
            Ok("large-output") => {
                let chunk = "x".repeat(8192);

                for _ in 0..256 {
                    print!("{chunk}");
                    eprint!("{chunk}");
                }
            }
            _ => {}
        }
    }

    #[test]
    fn bounded_auxiliary_cli_command_captures_success_output() {
        let mut command = test_child_command("json");
        let output = run_bounded_auxiliary_cli_command(
            &mut command,
            "scheduler",
            Some(5_000),
            None,
            SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES,
            AuxiliaryCliProcessMode::Supervised,
        )
        .expect("bounded command should finish");

        assert!(output.status.success());
        assert!(output.stdout.contains(r#"{"ok":true}"#));
        assert!(output.stderr.contains("child stderr"));
    }

    #[test]
    fn bounded_auxiliary_cli_command_times_out_and_stops_child() {
        let mut command = test_child_command("hang");
        let error = run_bounded_auxiliary_cli_command(
            &mut command,
            "scheduler",
            Some(1_000),
            None,
            SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES,
            AuxiliaryCliProcessMode::Supervised,
        )
        .expect_err("hanging command should time out");

        assert!(error.contains("The scheduler CLI exceeded the desktop safety timeout"));
        assert!(error.contains("was stopped"));
    }

    #[test]
    fn bounded_auxiliary_cli_command_caps_stdout_and_stderr() {
        let mut command = test_child_command("large-output");
        let output = run_bounded_auxiliary_cli_command(
            &mut command,
            "scheduler",
            Some(10_000),
            None,
            SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES,
            AuxiliaryCliProcessMode::Supervised,
        )
        .expect("large output command should finish");

        assert!(output.status.success());
        assert!(output.stdout.len() < SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES + 256);
        assert!(output.stderr.len() < SUBPROCESS_OUTPUT_CAPTURE_LIMIT_BYTES + 256);
        assert!(output.stdout.contains(SUBPROCESS_OUTPUT_TRUNCATED_MARKER));
        assert!(output.stderr.contains(SUBPROCESS_OUTPUT_TRUNCATED_MARKER));
        assert!(std::str::from_utf8(output.stdout.as_bytes()).is_ok());
        assert!(std::str::from_utf8(output.stderr.as_bytes()).is_ok());
    }

    #[test]
    fn auxiliary_parse_error_uses_bounded_output_snippet() {
        let error = parse_auxiliary_command_response(&"not-json".repeat(20 * 1024), "scheduler")
            .expect_err("invalid JSON should fail");

        assert!(error.contains("Failed to parse the scheduler CLI JSON response"));
        assert!(error.contains(COMMAND_DIAGNOSTIC_TRUNCATED_MARKER));
        assert!(error.len() < 18 * 1024);
    }

    #[test]
    fn auxiliary_parse_rejects_truncated_output_without_echoing_content() {
        let error = parse_auxiliary_command_response(
            &format!("private-body\n{SUBPROCESS_OUTPUT_TRUNCATED_MARKER}"),
            "instruction",
        )
        .expect_err("truncated JSON should fail");

        assert!(error.contains("exceeded its bounded desktop output limit"));
        assert!(!error.contains("private-body"));
    }
}
