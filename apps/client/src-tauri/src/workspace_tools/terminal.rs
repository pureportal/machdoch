use std::{
    collections::{HashMap, HashSet},
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::Duration,
};

#[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
use std::ffi::OsStr;
#[cfg(any(test, not(target_os = "macos")))]
use std::ffi::OsString;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;

use base64::{
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[cfg(windows)]
use crate::child_process::terminate_child_process_tree_by_id;
use crate::runtime_snapshot::resolve_workspace_root_path;

const MAX_TERMINAL_SESSIONS: usize = 32;
const MAX_WORKSPACE_TERMINAL_SESSIONS: usize = 8;
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_COLUMNS: u16 = 500;
const MAX_TERMINAL_ROWS: u16 = 300;
const TERMINAL_READ_BUFFER_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_EVENT_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_COALESCE_WINDOW: Duration = Duration::from_millis(2);
const TERMINAL_WORKER_QUEUE_DEPTH: usize = 16;
const TERMINAL_OUTPUT_HIGH_WATERMARK_BYTES: usize = 448 * 1024;
const TERMINAL_OUTPUT_LOW_WATERMARK_BYTES: usize = 128 * 1024;
const TERMINAL_OUTPUT_DRAIN_GRACE: Duration = Duration::from_secs(1);
const TERMINAL_STARTUP_STABILITY_WINDOW: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
struct ShellSpec {
    id: String,
    label: String,
    kind: String,
    program: PathBuf,
    args: Vec<String>,
}

#[derive(Debug, Clone)]
struct ExternalTerminalSpec {
    id: String,
    label: String,
    program: PathBuf,
    launch: ExternalTerminalLaunch,
}

#[derive(Debug, Clone)]
enum ExternalTerminalLaunch {
    #[cfg(any(test, windows))]
    WindowsTerminal,
    #[cfg(any(test, target_os = "macos"))]
    MacTerminal,
    #[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
    WorkingDirectoryArgument { argument: OsString, joined: bool },
    #[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
    InheritWorkingDirectory,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceShell {
    id: String,
    label: String,
    kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExternalTerminal {
    id: String,
    label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceShellDiscovery {
    platform: String,
    shells: Vec<WorkspaceShell>,
    default_shell_id: Option<String>,
    external_terminal: Option<WorkspaceExternalTerminal>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWorkspaceTerminalRequest {
    workspace_root: String,
    shell_id: String,
    columns: u16,
    rows: u16,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartedWorkspaceTerminal {
    session_id: String,
    shell_id: String,
    process_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceTerminalEvent {
    Output { session_id: String, data: String },
    Exit { exit_code: Option<u32> },
    Error { message: String },
}

struct TerminalSession {
    workspace_key: String,
    canonical_workspace_key: String,
    #[cfg(windows)]
    process_id: Option<u32>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output_flow: TerminalOutputFlow,
    stopped: AtomicBool,
}

struct TerminalOutputFlow {
    pending_output_bytes: Mutex<usize>,
    output_acknowledged: Condvar,
    output_cancelled: AtomicBool,
}

impl Default for TerminalOutputFlow {
    fn default() -> Self {
        Self {
            pending_output_bytes: Mutex::new(0),
            output_acknowledged: Condvar::new(),
            output_cancelled: AtomicBool::new(false),
        }
    }
}

impl TerminalOutputFlow {
    fn record_output(&self, bytes: usize) {
        if let Ok(mut pending) = self.pending_output_bytes.lock() {
            *pending = pending.saturating_add(bytes);
        }
    }

    fn acknowledge_output(&self, bytes: usize) {
        if let Ok(mut pending) = self.pending_output_bytes.lock() {
            *pending = pending.saturating_sub(bytes);
            self.output_acknowledged.notify_all();
        }
    }

    fn clear_pending_output(&self) {
        if let Ok(mut pending) = self.pending_output_bytes.lock() {
            *pending = 0;
            self.output_acknowledged.notify_all();
        }
    }

    fn cancel_output(&self) {
        self.output_cancelled.store(true, Ordering::SeqCst);
        self.output_acknowledged.notify_all();
    }

    fn wait_for_output_capacity(&self) {
        self.wait_for_output_capacity_when(|| {});
    }

    fn wait_for_output_capacity_when(&self, waiting: impl FnOnce()) {
        let Ok(mut pending) = self.pending_output_bytes.lock() else {
            return;
        };
        if *pending < TERMINAL_OUTPUT_HIGH_WATERMARK_BYTES {
            return;
        }
        waiting();
        while *pending > TERMINAL_OUTPUT_LOW_WATERMARK_BYTES
            && !self.output_cancelled.load(Ordering::SeqCst)
        {
            let Ok((next_pending, _)) = self
                .output_acknowledged
                .wait_timeout(pending, Duration::from_secs(1))
            else {
                return;
            };
            pending = next_pending;
        }
    }
}

impl TerminalSession {
    fn close_handles(&self) {
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
    }

    fn stop(&self) -> Result<(), String> {
        self.output_flow.cancel_output();
        if self.stopped.swap(true, Ordering::SeqCst) {
            self.close_handles();
            return Ok(());
        }
        #[cfg(windows)]
        if self
            .process_id
            .is_some_and(terminate_child_process_tree_by_id)
        {
            self.close_handles();
            return Ok(());
        }
        let result = match self
            .killer
            .lock()
            .map_err(|_| "The terminal process lock is unavailable.".to_string())?
            .kill()
        {
            Ok(()) => Ok(()),
            #[cfg(windows)]
            Err(error) if error.raw_os_error() == Some(0) => Ok(()),
            Err(error) => Err(format!("Unable to stop the terminal process: {error}")),
        };
        self.close_handles();
        result
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.output_flow
            .output_cancelled
            .store(true, Ordering::SeqCst);
        if !self.stopped.swap(true, Ordering::SeqCst) {
            #[cfg(windows)]
            let tree_stopped = self
                .process_id
                .is_some_and(terminate_child_process_tree_by_id);
            #[cfg(not(windows))]
            let tree_stopped = false;
            if !tree_stopped {
                if let Ok(killer) = self.killer.get_mut() {
                    let _ = killer.kill();
                }
            }
        }
        self.output_flow.output_acknowledged.notify_all();
        if let Ok(writer) = self.writer.get_mut() {
            writer.take();
        }
        if let Ok(master) = self.master.get_mut() {
            master.take();
        }
    }
}

type TerminalSessions = Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>;

pub struct WorkspaceTerminalState {
    sessions: TerminalSessions,
}

impl Default for WorkspaceTerminalState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Drop for WorkspaceTerminalState {
    fn drop(&mut self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session in sessions {
            let _ = session.stop();
        }
    }
}

#[cfg(windows)]
fn strip_ascii_prefix_case_insensitive<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|candidate| candidate.eq_ignore_ascii_case(prefix))
        .and_then(|_| value.get(prefix.len()..))
}

#[cfg(windows)]
fn normalize_windows_workspace_root_input(workspace_root: &str) -> String {
    let mut normalized = workspace_root;
    for prefix in [r"Microsoft.PowerShell.Core\FileSystem::", "FileSystem::"] {
        if let Some(remainder) = strip_ascii_prefix_case_insensitive(normalized, prefix) {
            normalized = remainder;
            break;
        }
    }
    shell_compatible_path(Path::new(normalized))
        .to_string_lossy()
        .into_owned()
}

#[cfg(not(windows))]
fn normalize_workspace_root_input(workspace_root: &str) -> String {
    workspace_root.to_string()
}

#[cfg(windows)]
fn normalize_workspace_root_input(workspace_root: &str) -> String {
    normalize_windows_workspace_root_input(workspace_root)
}

#[cfg(windows)]
fn shell_compatible_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};

    const VERBATIM_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];

    let encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    let starts_with_ascii_case_insensitive = |prefix: &[u16]| {
        encoded.len() >= prefix.len()
            && encoded
                .iter()
                .zip(prefix)
                .take(prefix.len())
                .all(|(actual, expected)| {
                    char::from_u32(u32::from(*actual))
                        .zip(char::from_u32(u32::from(*expected)))
                        .is_some_and(|(actual, expected)| actual.eq_ignore_ascii_case(&expected))
                })
    };

    if starts_with_ascii_case_insensitive(VERBATIM_UNC_PREFIX) {
        let mut normalized = vec![b'\\' as u16, b'\\' as u16];
        normalized.extend_from_slice(&encoded[VERBATIM_UNC_PREFIX.len()..]);
        return PathBuf::from(OsString::from_wide(&normalized));
    }
    if encoded.starts_with(VERBATIM_PREFIX)
        && encoded.get(VERBATIM_PREFIX.len()).is_some_and(|value| {
            char::from_u32(u32::from(*value)).is_some_and(|value| value.is_ascii_alphabetic())
        })
        && encoded.get(VERBATIM_PREFIX.len() + 1) == Some(&(b':' as u16))
    {
        return PathBuf::from(OsString::from_wide(&encoded[VERBATIM_PREFIX.len()..]));
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn shell_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn canonical_shell_path(path: &Path) -> PathBuf {
    shell_compatible_path(&path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
}

fn canonical_workspace_root(workspace_root: &str) -> Result<PathBuf, String> {
    if workspace_root.trim().is_empty() {
        return Err("Select a workspace first.".to_string());
    }
    resolve_workspace_root_path(&normalize_workspace_root_input(workspace_root))
}

fn shell_workspace_root(workspace_root: &str) -> Result<(PathBuf, PathBuf), String> {
    let canonical = canonical_workspace_root(workspace_root)?;
    let shell_path = shell_compatible_path(&canonical);
    Ok((canonical, shell_path))
}

fn normalized_workspace_key(workspace_root: &str) -> String {
    let normalized = normalize_workspace_root_input(workspace_root).replace('\\', "/");
    let without_trailing_separators = normalized.trim_end_matches('/');
    let key = if without_trailing_separators.is_empty() {
        normalized
    } else {
        without_trailing_separators.to_string()
    };
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

fn terminal_session_matches_workspace(
    session: &TerminalSession,
    requested_key: &str,
    canonical_key: Option<&str>,
) -> bool {
    session.workspace_key == requested_key
        || session.canonical_workspace_key == requested_key
        || canonical_key.is_some_and(|key| {
            session.workspace_key == key || session.canonical_workspace_key == key
        })
}

fn validate_terminal_session_capacity(
    sessions: &HashMap<String, Arc<TerminalSession>>,
    workspace_key: &str,
    canonical_workspace_key: &str,
) -> Result<(), String> {
    if sessions.len() >= MAX_TERMINAL_SESSIONS {
        return Err("Close an existing terminal before starting another.".to_string());
    }
    let workspace_session_count = sessions
        .values()
        .filter(|session| {
            terminal_session_matches_workspace(
                session,
                workspace_key,
                Some(canonical_workspace_key),
            )
        })
        .count();
    if workspace_session_count >= MAX_WORKSPACE_TERMINAL_SESSIONS {
        return Err("Close a terminal in this workspace before starting another.".to_string());
    }
    Ok(())
}

fn path_extensions(pathext: Option<&str>) -> Vec<String> {
    #[cfg(windows)]
    {
        let raw = pathext.unwrap_or(".COM;.EXE;.BAT;.CMD");
        raw.split(';')
            .filter_map(|extension| {
                let trimmed = extension.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_ascii_lowercase())
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = pathext;
        vec![String::new()]
    }
}

fn executable_candidates(program: &str, pathext: Option<&str>) -> Vec<String> {
    #[cfg(windows)]
    {
        if Path::new(program).extension().is_some() {
            vec![program.to_string()]
        } else {
            let mut candidates = vec![program.to_string()];
            candidates.extend(
                path_extensions(pathext)
                    .into_iter()
                    .map(|extension| format!("{program}{extension}")),
            );
            candidates
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pathext;
        vec![program.to_string()]
    }
}

fn find_executable_in(
    program: &str,
    path_value: Option<&std::ffi::OsStr>,
    pathext: Option<&str>,
) -> Option<PathBuf> {
    let direct = PathBuf::from(program);
    if (direct.is_absolute() || direct.components().count() > 1) && is_executable_file(&direct) {
        return Some(canonical_shell_path(&direct));
    }

    let paths = path_value.map(env::split_paths)?;
    let candidates = executable_candidates(program, pathext);
    for directory in paths {
        for candidate in &candidates {
            let path = directory.join(candidate);
            if is_executable_file(&path) {
                return Some(canonical_shell_path(&path));
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn find_executable(program: &str) -> Option<PathBuf> {
    find_executable_in(
        program,
        env::var_os("PATH").as_deref(),
        env::var("PATHEXT").ok().as_deref(),
    )
}

fn existing_file(path: PathBuf) -> Option<PathBuf> {
    is_executable_file(&path).then(|| canonical_shell_path(&path))
}

fn push_shell(
    shells: &mut Vec<ShellSpec>,
    seen_programs: &mut HashSet<String>,
    id: &str,
    label: &str,
    kind: &str,
    program: Option<PathBuf>,
    args: &[&str],
) {
    let Some(program) = program else {
        return;
    };
    let identity = if cfg!(windows) {
        program.to_string_lossy().to_lowercase()
    } else {
        program.to_string_lossy().into_owned()
    };
    if !seen_programs.insert(identity) {
        return;
    }
    shells.push(ShellSpec {
        id: id.to_string(),
        label: label.to_string(),
        kind: kind.to_string(),
        program,
        args: args
            .iter()
            .map(|argument| (*argument).to_string())
            .collect(),
    });
}

#[cfg(windows)]
fn discover_shell_specs() -> Vec<ShellSpec> {
    let mut shells = Vec::new();
    let mut seen = HashSet::new();

    push_shell(
        &mut shells,
        &mut seen,
        "pwsh",
        "PowerShell",
        "powershell",
        find_executable("pwsh.exe").or_else(|| find_executable("pwsh")),
        &["-NoLogo"],
    );

    let windows_powershell = env::var_os("SystemRoot")
        .map(PathBuf::from)
        .and_then(|root| {
            existing_file(
                root.join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe"),
            )
        })
        .or_else(|| find_executable("powershell.exe"));
    push_shell(
        &mut shells,
        &mut seen,
        "windows-powershell",
        "Windows PowerShell",
        "powershell",
        windows_powershell,
        &["-NoLogo"],
    );

    let command_prompt = env::var_os("ComSpec")
        .map(PathBuf::from)
        .and_then(existing_file)
        .or_else(|| find_executable("cmd.exe"));
    push_shell(
        &mut shells,
        &mut seen,
        "cmd",
        "Command Prompt",
        "cmd",
        command_prompt,
        &["/D"],
    );

    let mut git_bash_candidates = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
        if let Some(root) = env::var_os(variable).map(PathBuf::from) {
            git_bash_candidates.push(root.join("Git").join("bin").join("bash.exe"));
        }
    }
    let git_bash = git_bash_candidates.into_iter().find_map(existing_file);
    push_shell(
        &mut shells,
        &mut seen,
        "git-bash",
        "Git Bash",
        "bash",
        git_bash,
        &["--login", "-i"],
    );

    push_shell(
        &mut shells,
        &mut seen,
        "wsl",
        "WSL",
        "wsl",
        find_executable("wsl.exe"),
        &[],
    );
    push_shell(
        &mut shells,
        &mut seen,
        "nu",
        "Nushell",
        "nu",
        find_executable("nu.exe").or_else(|| find_executable("nu")),
        &[],
    );
    shells
}

#[cfg(not(windows))]
fn discover_shell_specs() -> Vec<ShellSpec> {
    let mut shells = Vec::new();
    let mut seen = HashSet::new();
    if let Some(configured_shell) = env::var_os("SHELL") {
        let path = PathBuf::from(configured_shell);
        let label = path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(|value| {
                let mut characters = value.chars();
                characters
                    .next()
                    .map(|first| first.to_uppercase().collect::<String>() + characters.as_str())
                    .unwrap_or_else(|| "Shell".to_string())
            })
            .unwrap_or_else(|| "Shell".to_string());
        push_shell(
            &mut shells,
            &mut seen,
            "default",
            &label,
            "shell",
            existing_file(path),
            &[],
        );
    }

    for (id, label, kind, executable) in [
        ("zsh", "Zsh", "zsh", "zsh"),
        ("bash", "Bash", "bash", "bash"),
        ("fish", "Fish", "fish", "fish"),
        ("nu", "Nushell", "nu", "nu"),
        ("sh", "sh", "sh", "sh"),
    ] {
        push_shell(
            &mut shells,
            &mut seen,
            id,
            label,
            kind,
            find_executable(executable),
            &[],
        );
    }
    shells
}

#[cfg(windows)]
fn discover_external_terminal_specs() -> Vec<ExternalTerminalSpec> {
    find_executable("wt.exe")
        .map(|program| {
            vec![ExternalTerminalSpec {
                id: "windows-terminal".to_string(),
                label: "Windows Terminal".to_string(),
                program,
                launch: ExternalTerminalLaunch::WindowsTerminal,
            }]
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn discover_external_terminal_specs() -> Vec<ExternalTerminalSpec> {
    find_executable("open")
        .map(|program| {
            vec![ExternalTerminalSpec {
                id: "terminal-app".to_string(),
                label: "Terminal".to_string(),
                program,
                launch: ExternalTerminalLaunch::MacTerminal,
            }]
        })
        .unwrap_or_default()
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn discover_external_terminal_specs() -> Vec<ExternalTerminalSpec> {
    let candidates = [
        (
            "gnome-terminal",
            "GNOME Terminal",
            Some("--working-directory="),
        ),
        ("konsole", "Konsole", Some("--workdir")),
        (
            "xfce4-terminal",
            "Xfce Terminal",
            Some("--working-directory="),
        ),
        ("kitty", "Kitty", Some("--directory")),
        ("alacritty", "Alacritty", Some("--working-directory")),
        ("x-terminal-emulator", "System terminal", None),
        ("xterm", "XTerm", None),
    ];
    for (program_name, label, directory_argument) in candidates {
        if let Some(program) = find_executable(program_name) {
            return vec![ExternalTerminalSpec {
                id: program_name.to_string(),
                label: label.to_string(),
                program,
                launch: directory_argument
                    .map(
                        |argument: &str| ExternalTerminalLaunch::WorkingDirectoryArgument {
                            argument: argument.into(),
                            joined: argument.ends_with('='),
                        },
                    )
                    .unwrap_or(ExternalTerminalLaunch::InheritWorkingDirectory),
            }];
        }
    }
    Vec::new()
}

fn discovery_snapshot() -> WorkspaceShellDiscovery {
    let shells = discover_shell_specs();
    let external_terminal = discover_external_terminal_specs()
        .into_iter()
        .next()
        .map(|terminal| WorkspaceExternalTerminal {
            id: terminal.id,
            label: terminal.label,
        });
    WorkspaceShellDiscovery {
        platform: env::consts::OS.to_string(),
        default_shell_id: shells.first().map(|shell| shell.id.clone()),
        shells: shells
            .into_iter()
            .map(|shell| WorkspaceShell {
                id: shell.id,
                label: shell.label,
                kind: shell.kind,
            })
            .collect(),
        external_terminal,
    }
}

#[tauri::command]
pub async fn discover_workspace_shells() -> Result<WorkspaceShellDiscovery, String> {
    tauri::async_runtime::spawn_blocking(discovery_snapshot)
        .await
        .map_err(|error| format!("Shell discovery stopped unexpectedly: {error}"))
}

fn validate_terminal_size(columns: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=MAX_TERMINAL_COLUMNS).contains(&columns) || !(1..=MAX_TERMINAL_ROWS).contains(&rows) {
        return Err("The requested terminal size is out of range.".to_string());
    }
    Ok(PtySize {
        rows,
        cols: columns,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn next_session_id() -> Result<String, String> {
    let mut random = [0_u8; 24];
    getrandom::fill(&mut random)
        .map_err(|_| "Unable to create a terminal session identifier.".to_string())?;
    Ok(format!("terminal-{}", URL_SAFE_NO_PAD.encode(random)))
}

fn send_terminal_event(
    channel: &Channel<WorkspaceTerminalEvent>,
    event: WorkspaceTerminalEvent,
) -> bool {
    channel.send(event).is_ok()
}

enum TerminalWorkerEvent {
    Output(Vec<u8>),
    ReaderDone(Option<String>),
    Exit {
        exit_code: Option<u32>,
        error: Option<String>,
    },
}

enum TerminalStartupOutcome {
    Exited(u32),
    WaitFailed(String),
}

fn build_shell_command(shell: &ShellSpec, workspace: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new(&shell.program);
    command.args(shell.args.iter());
    command.cwd(workspace);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command
}

fn startup_failure_message(shell_label: &str, outcome: TerminalStartupOutcome) -> String {
    match outcome {
        TerminalStartupOutcome::Exited(exit_code) => format!(
            "{shell_label} exited during startup with code {exit_code} (0x{exit_code:08x}). Try another available shell or check its startup configuration."
        ),
        TerminalStartupOutcome::WaitFailed(error) => format!(
            "{shell_label} stopped during startup: {error}. Try another available shell or check its installation."
        ),
    }
}

fn start_terminal_sync(
    sessions: TerminalSessions,
    request: StartWorkspaceTerminalRequest,
    on_event: Channel<WorkspaceTerminalEvent>,
) -> Result<StartedWorkspaceTerminal, String> {
    let size = validate_terminal_size(request.columns, request.rows)?;
    let (canonical_workspace, workspace) = shell_workspace_root(&request.workspace_root)?;
    let workspace_key = normalized_workspace_key(&request.workspace_root);
    let canonical_workspace_key = normalized_workspace_key(&canonical_workspace.to_string_lossy());
    let shell = discover_shell_specs()
        .into_iter()
        .find(|shell| shell.id == request.shell_id)
        .ok_or_else(|| "That shell is no longer available.".to_string())?;
    let session_id = next_session_id()?;

    {
        let registry = sessions
            .lock()
            .map_err(|_| "The terminal session registry is unavailable.".to_string())?;
        validate_terminal_session_capacity(&registry, &workspace_key, &canonical_workspace_key)?;
    }

    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| format!("Unable to create a terminal: {error}"))?;
    let command = build_shell_command(&shell, &workspace);
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| {
            format!(
                "Unable to start {}: {error}. Try another available shell or verify that it starts outside Machdoch.",
                shell.label
            )
        })?;
    drop(pair.slave);

    let process_id = child.process_id();
    let mut killer = child.clone_killer();
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = killer.kill();
            let _ = child.wait();
            return Err(format!("Unable to read terminal output: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = killer.kill();
            let _ = child.wait();
            return Err(format!("Unable to open terminal input: {error}"));
        }
    };
    let session = Arc::new(TerminalSession {
        workspace_key,
        canonical_workspace_key,
        #[cfg(windows)]
        process_id,
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(killer),
        output_flow: TerminalOutputFlow::default(),
        stopped: AtomicBool::new(false),
    });

    {
        let mut registry = sessions
            .lock()
            .map_err(|_| "The terminal session registry is unavailable.".to_string())?;
        if let Err(error) = validate_terminal_session_capacity(
            &registry,
            &session.workspace_key,
            &session.canonical_workspace_key,
        ) {
            let _ = session.stop();
            return Err(error);
        }
        registry.insert(session_id.clone(), Arc::clone(&session));
    }

    let (worker_sender, worker_receiver) =
        mpsc::sync_channel::<TerminalWorkerEvent>(TERMINAL_WORKER_QUEUE_DEPTH);
    let aggregator_session_id = session_id.clone();
    let aggregator_sessions = Arc::clone(&sessions);
    let aggregator_session = Arc::clone(&session);
    thread::Builder::new()
        .name(format!("machdoch-terminal-events-{process_id:?}"))
        .spawn(move || {
            let mut reader_done = false;
            let mut exit_code = None;
            let mut exit_received = false;
            let mut channel_open = true;
            let mut queued_event = None;
            loop {
                let received = if let Some(event) = queued_event.take() {
                    Ok(event)
                } else if exit_received || reader_done {
                    worker_receiver
                        .recv_timeout(TERMINAL_OUTPUT_DRAIN_GRACE)
                        .map_err(|_| ())
                } else {
                    worker_receiver.recv().map_err(|_| ())
                };
                let Ok(event) = received else {
                    break;
                };
                match event {
                    TerminalWorkerEvent::Output(mut bytes) => {
                        while bytes.len() < TERMINAL_OUTPUT_EVENT_BYTES {
                            match worker_receiver.recv_timeout(TERMINAL_OUTPUT_COALESCE_WINDOW) {
                                Ok(TerminalWorkerEvent::Output(next_bytes))
                                    if bytes.len() + next_bytes.len()
                                        <= TERMINAL_OUTPUT_EVENT_BYTES =>
                                {
                                    bytes.extend(next_bytes);
                                }
                                Ok(next_event) => {
                                    queued_event = Some(next_event);
                                    break;
                                }
                                Err(_) => break,
                            }
                        }
                        if channel_open
                            && !aggregator_session
                                .output_flow
                                .output_cancelled
                                .load(Ordering::SeqCst)
                        {
                            let byte_count = bytes.len();
                            let data = BASE64_STANDARD.encode(bytes);
                            aggregator_session.output_flow.record_output(byte_count);
                            if !send_terminal_event(
                                &on_event,
                                WorkspaceTerminalEvent::Output {
                                    session_id: aggregator_session_id.clone(),
                                    data,
                                },
                            ) {
                                channel_open = false;
                                aggregator_session.output_flow.clear_pending_output();
                            } else {
                                aggregator_session.output_flow.wait_for_output_capacity();
                            }
                        }
                    }
                    TerminalWorkerEvent::ReaderDone(error) => {
                        reader_done = true;
                        let output_failed = error.is_some();
                        if channel_open {
                            if let Some(message) = error {
                                channel_open = send_terminal_event(
                                    &on_event,
                                    WorkspaceTerminalEvent::Error { message },
                                );
                            }
                        }
                        if output_failed && !aggregator_session.stopped.load(Ordering::SeqCst) {
                            let _ = aggregator_session.stop();
                        }
                    }
                    TerminalWorkerEvent::Exit {
                        exit_code: code,
                        error,
                    } => {
                        exit_received = true;
                        exit_code = code;
                        if channel_open {
                            if let Some(message) = error {
                                channel_open = send_terminal_event(
                                    &on_event,
                                    WorkspaceTerminalEvent::Error { message },
                                );
                            }
                        }
                    }
                }
                if !channel_open && !aggregator_session.stopped.load(Ordering::SeqCst) {
                    let _ = aggregator_session.stop();
                }
                if reader_done && exit_received {
                    break;
                }
            }
            if reader_done && !exit_received {
                let _ = aggregator_session.stop();
                exit_received = true;
            }
            if let Ok(mut registry) = aggregator_sessions.lock() {
                registry.remove(&aggregator_session_id);
            }
            aggregator_session.output_flow.clear_pending_output();
            if channel_open && exit_received {
                let _ = send_terminal_event(&on_event, WorkspaceTerminalEvent::Exit { exit_code });
            }
        })
        .map_err(|error| {
            if let Ok(mut registry) = sessions.lock() {
                registry.remove(&session_id);
            }
            let _ = session.stop();
            format!("Unable to start the terminal event worker: {error}")
        })?;

    let reader_sender = worker_sender.clone();
    let reader_session = Arc::clone(&session);
    thread::Builder::new()
        .name(format!("machdoch-terminal-output-{process_id:?}"))
        .spawn(move || {
            let mut reader = reader;
            let mut buffer = vec![0_u8; TERMINAL_READ_BUFFER_BYTES];
            let reader_error = loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break None,
                    Ok(read) => {
                        if reader_sender
                            .send(TerminalWorkerEvent::Output(buffer[..read].to_vec()))
                            .is_err()
                        {
                            let _ = reader_session.stop();
                            return;
                        }
                    }
                    Err(error) => {
                        break (!reader_session.stopped.load(Ordering::SeqCst))
                            .then(|| format!("Terminal output stopped: {error}"));
                    }
                }
            };
            let _ = reader_sender.send(TerminalWorkerEvent::ReaderDone(reader_error));
        })
        .map_err(|error| {
            let _ = session.stop();
            let message = format!("Unable to start the terminal output worker: {error}");
            let _ = worker_sender.send(TerminalWorkerEvent::ReaderDone(Some(message.clone())));
            let _ = worker_sender.send(TerminalWorkerEvent::Exit {
                exit_code: None,
                error: None,
            });
            message
        })?;

    let wait_failure_sender = worker_sender.clone();
    let wait_sender = worker_sender;
    let wait_session = Arc::clone(&session);
    let (startup_sender, startup_receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name(format!("machdoch-terminal-wait-{process_id:?}"))
        .spawn(move || {
            let result = child.wait();
            let event = match result {
                Ok(status) => {
                    wait_session.stopped.store(true, Ordering::SeqCst);
                    wait_session.close_handles();
                    let exit_code = status.exit_code();
                    let _ = startup_sender.send(TerminalStartupOutcome::Exited(exit_code));
                    TerminalWorkerEvent::Exit {
                        exit_code: Some(exit_code),
                        error: None,
                    }
                }
                Err(error) => {
                    let _ = wait_session.stop();
                    let message = format!("Unable to wait for the terminal process: {error}");
                    let _ =
                        startup_sender.send(TerminalStartupOutcome::WaitFailed(message.clone()));
                    TerminalWorkerEvent::Exit {
                        exit_code: None,
                        error: Some(message),
                    }
                }
            };
            let _ = wait_sender.send(event);
        })
        .map_err(|error| {
            let _ = session.stop();
            let message = format!("Unable to start the terminal lifecycle worker: {error}");
            let _ = wait_failure_sender.send(TerminalWorkerEvent::Exit {
                exit_code: None,
                error: Some(message.clone()),
            });
            message
        })?;

    if let Ok(outcome) = startup_receiver.recv_timeout(TERMINAL_STARTUP_STABILITY_WINDOW) {
        session.output_flow.cancel_output();
        if let Ok(mut registry) = sessions.lock() {
            registry.remove(&session_id);
        }
        return Err(startup_failure_message(&shell.label, outcome));
    }

    Ok(StartedWorkspaceTerminal {
        session_id,
        shell_id: shell.id,
        process_id,
    })
}

#[tauri::command]
pub async fn start_workspace_terminal(
    state: tauri::State<'_, WorkspaceTerminalState>,
    request: StartWorkspaceTerminalRequest,
    on_event: Channel<WorkspaceTerminalEvent>,
) -> Result<StartedWorkspaceTerminal, String> {
    let sessions = Arc::clone(&state.sessions);
    tauri::async_runtime::spawn_blocking(move || start_terminal_sync(sessions, request, on_event))
        .await
        .map_err(|error| format!("Terminal startup stopped unexpectedly: {error}"))?
}

fn find_session(
    sessions: &TerminalSessions,
    session_id: &str,
) -> Result<Arc<TerminalSession>, String> {
    sessions
        .lock()
        .map_err(|_| "The terminal session registry is unavailable.".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "This terminal is no longer running.".to_string())
}

#[tauri::command]
pub async fn write_workspace_terminal(
    state: tauri::State<'_, WorkspaceTerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err("Terminal input is too large.".to_string());
    }
    let session = find_session(&state.sessions, &session_id)?;
    write_terminal_input(session, data.into_bytes()).await
}

async fn write_terminal_input(session: Arc<TerminalSession>, data: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if session.stopped.load(Ordering::SeqCst) {
            return Err("This terminal is no longer running.".to_string());
        }
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "The terminal input lock is unavailable.".to_string())?;
        let writer = writer
            .as_mut()
            .ok_or_else(|| "This terminal is no longer running.".to_string())?;
        writer
            .write_all(&data)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Unable to write terminal input: {error}"))
    })
    .await
    .map_err(|error| format!("Terminal input stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn write_workspace_terminal_binary(
    state: tauri::State<'_, WorkspaceTerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES.saturating_mul(2) {
        return Err("Terminal input is too large.".to_string());
    }
    let data = BASE64_STANDARD
        .decode(data)
        .map_err(|_| "Terminal input is not valid binary data.".to_string())?;
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err("Terminal input is too large.".to_string());
    }
    let session = find_session(&state.sessions, &session_id)?;
    write_terminal_input(session, data).await
}

#[tauri::command]
pub async fn acknowledge_workspace_terminal_output(
    state: tauri::State<'_, WorkspaceTerminalState>,
    session_id: String,
    bytes: usize,
) -> Result<(), String> {
    if bytes > TERMINAL_OUTPUT_HIGH_WATERMARK_BYTES.saturating_mul(2) {
        return Err("The terminal output acknowledgement is too large.".to_string());
    }
    let session = state
        .sessions
        .lock()
        .map_err(|_| "The terminal session registry is unavailable.".to_string())?
        .get(&session_id)
        .cloned();
    if let Some(session) = session {
        session.output_flow.acknowledge_output(bytes);
    }
    Ok(())
}

#[tauri::command]
pub async fn resize_workspace_terminal(
    state: tauri::State<'_, WorkspaceTerminalState>,
    session_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    let size = validate_terminal_size(columns, rows)?;
    let session = find_session(&state.sessions, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let master = session
            .master
            .lock()
            .map_err(|_| "The terminal size lock is unavailable.".to_string())?;
        master
            .as_ref()
            .ok_or_else(|| "This terminal is no longer running.".to_string())?
            .resize(size)
            .map_err(|error| format!("Unable to resize the terminal: {error}"))
    })
    .await
    .map_err(|error| format!("Terminal resize stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn stop_workspace_terminal(
    state: tauri::State<'_, WorkspaceTerminalState>,
    session_id: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "The terminal session registry is unavailable.".to_string())?
        .remove(&session_id);
    let Some(session) = session else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || session.stop())
        .await
        .map_err(|error| format!("Terminal shutdown stopped unexpectedly: {error}"))?
}

fn stop_workspace_terminals_sync(
    sessions: &TerminalSessions,
    workspace_root: &str,
) -> Result<usize, String> {
    let requested_key = normalized_workspace_key(workspace_root);
    let canonical_key = canonical_workspace_root(workspace_root)
        .ok()
        .map(|workspace| normalized_workspace_key(&workspace.to_string_lossy()));
    let removed = {
        let mut registry = sessions
            .lock()
            .map_err(|_| "The terminal session registry is unavailable.".to_string())?;
        let matching_ids = registry
            .iter()
            .filter(|(_, session)| {
                terminal_session_matches_workspace(
                    session,
                    &requested_key,
                    canonical_key.as_deref(),
                )
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        matching_ids
            .into_iter()
            .filter_map(|session_id| registry.remove(&session_id))
            .collect::<Vec<_>>()
    };

    let count = removed.len();
    let failures = removed
        .into_iter()
        .filter_map(|session| session.stop().err())
        .collect::<Vec<_>>();
    if failures.is_empty() {
        Ok(count)
    } else {
        Err(format!(
            "Unable to stop every terminal in this workspace: {}",
            failures.join("; ")
        ))
    }
}

#[tauri::command]
pub async fn stop_workspace_terminals(
    state: tauri::State<'_, WorkspaceTerminalState>,
    workspace_root: String,
) -> Result<usize, String> {
    let sessions = Arc::clone(&state.sessions);
    tauri::async_runtime::spawn_blocking(move || {
        stop_workspace_terminals_sync(&sessions, &workspace_root)
    })
    .await
    .map_err(|error| format!("Workspace terminal shutdown stopped unexpectedly: {error}"))?
}

#[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
fn joined_path_argument(argument: &OsStr, workspace: &Path) -> OsString {
    let mut joined = argument.to_os_string();
    joined.push(workspace.as_os_str());
    joined
}

fn build_external_terminal_command(terminal: &ExternalTerminalSpec, workspace: &Path) -> Command {
    let mut command = Command::new(&terminal.program);
    command.current_dir(workspace);
    match &terminal.launch {
        #[cfg(any(test, windows))]
        ExternalTerminalLaunch::WindowsTerminal => {
            command.arg("-d").arg(workspace);
        }
        #[cfg(any(test, target_os = "macos"))]
        ExternalTerminalLaunch::MacTerminal => {
            command.arg("-a").arg("Terminal").arg(workspace);
        }
        #[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
        ExternalTerminalLaunch::WorkingDirectoryArgument { argument, joined } => {
            if *joined {
                command.arg(joined_path_argument(argument, workspace));
            } else {
                command.arg(argument).arg(workspace);
            }
        }
        #[cfg(any(test, all(not(windows), not(target_os = "macos"))))]
        ExternalTerminalLaunch::InheritWorkingDirectory => {}
    }
    command
}

fn open_external_terminal_sync(workspace_root: &str, terminal_id: &str) -> Result<(), String> {
    let (_, workspace) = shell_workspace_root(workspace_root)?;
    let terminal = discover_external_terminal_specs()
        .into_iter()
        .find(|terminal| terminal.id == terminal_id)
        .ok_or_else(|| "That external terminal is no longer available.".to_string())?;
    let mut command = build_external_terminal_command(&terminal, &workspace);
    let mut child = command
        .spawn()
        .map_err(|error| {
            format!(
                "Unable to open {}: {error}. Verify that the terminal can start in this desktop session.",
                terminal.label
            )
        })?;
    let process_id = child.id();
    thread::Builder::new()
        .name(format!("machdoch-external-terminal-{process_id}"))
        .spawn(move || {
            let _ = child.wait();
        })
        .map(|_| ())
        .map_err(|error| {
            format!(
                "{} opened, but its process could not be monitored: {error}",
                terminal.label
            )
        })
}

#[tauri::command]
pub async fn open_workspace_terminal_host(
    workspace_root: String,
    terminal_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_external_terminal_sync(&workspace_root, &terminal_id)
    })
    .await
    .map_err(|error| format!("External terminal startup stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use super::*;

    #[test]
    fn executable_lookup_uses_only_existing_path_entries() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let root = env::temp_dir().join(format!("machdoch-shell-path-{unique}"));
        fs::create_dir_all(&root).expect("test path should create");
        let file_name = if cfg!(windows) {
            "test-shell.exe"
        } else {
            "test-shell"
        };
        fs::write(root.join(file_name), b"fixture").expect("test executable should write");
        #[cfg(unix)]
        fs::set_permissions(root.join(file_name), fs::Permissions::from_mode(0o755))
            .expect("test executable permissions should set");
        let path_value = env::join_paths([&root]).expect("test PATH should join");
        let found = find_executable_in("test-shell", Some(&path_value), Some(".EXE"))
            .expect("executable should resolve");
        assert!(found.is_file());
        assert!(find_executable_in("missing-shell", Some(&path_value), Some(".EXE")).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovered_shells_are_unique_and_exist() {
        let shells = discover_shell_specs();
        let mut ids = HashSet::new();
        let mut programs = HashSet::new();
        for shell in shells {
            assert!(ids.insert(shell.id));
            assert!(shell.program.is_file());
            let identity = shell.program.to_string_lossy().to_lowercase();
            assert!(programs.insert(identity));
        }
    }

    #[test]
    fn terminal_events_serialize_with_frontend_field_names() {
        assert_eq!(
            serde_json::to_value(WorkspaceTerminalEvent::Output {
                session_id: "terminal-1".to_string(),
                data: "dGVzdA==".to_string(),
            })
            .expect("output event should serialize"),
            serde_json::json!({
                "type": "output",
                "sessionId": "terminal-1",
                "data": "dGVzdA==",
            })
        );
        assert_eq!(
            serde_json::to_value(WorkspaceTerminalEvent::Exit { exit_code: Some(7) })
                .expect("exit event should serialize"),
            serde_json::json!({
                "type": "exit",
                "exitCode": 7,
            })
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_paths_do_not_expose_verbatim_or_provider_prefixes() {
        assert_eq!(
            shell_compatible_path(Path::new(r"\\?\C:\Projects\Machdoch Workspace")),
            PathBuf::from(r"C:\Projects\Machdoch Workspace")
        );
        assert_eq!(
            shell_compatible_path(Path::new(r"\\?\UNC\server\share\Machdoch Workspace")),
            PathBuf::from(r"\\server\share\Machdoch Workspace")
        );
        assert_eq!(
            shell_compatible_path(Path::new(
                r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\workspace"
            )),
            PathBuf::from(r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\workspace")
        );
        assert_eq!(
            normalize_windows_workspace_root_input(
                r"Microsoft.PowerShell.Core\FileSystem::\\?\C:\Projects\Machdoch Workspace"
            ),
            r"C:\Projects\Machdoch Workspace"
        );

        for shell in discover_shell_specs() {
            assert!(
                !shell.program.to_string_lossy().starts_with(r"\\?\"),
                "{} must receive an application-compatible executable path, got {}",
                shell.label,
                shell.program.display()
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_powershell_initializes_from_discovered_executable_path() {
        let Some(shell) = discover_shell_specs()
            .into_iter()
            .find(|shell| shell.id == "windows-powershell")
        else {
            return;
        };
        let output = Command::new(&shell.program)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[void][Net.ServicePointManager]::SecurityProtocol; exit 0",
            ])
            .output()
            .expect("Windows PowerShell startup probe should run");
        assert!(
            output.status.success(),
            "Windows PowerShell should initialize from {}; stderr: {}",
            shell.program.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn shell_commands_keep_arguments_and_working_directories_structured() {
        let workspace = PathBuf::from("workspace with spaces");
        let shell = ShellSpec {
            id: "test-shell".to_string(),
            label: "Test shell".to_string(),
            kind: "shell".to_string(),
            program: PathBuf::from("test shell executable"),
            args: vec!["--login".to_string(), "argument with spaces".to_string()],
        };
        let command = build_shell_command(&shell, &workspace);
        assert_eq!(
            command.get_cwd().map(OsString::as_os_str),
            Some(workspace.as_os_str())
        );
        assert_eq!(
            command.get_argv(),
            &vec![
                OsString::from("test shell executable"),
                OsString::from("--login"),
                OsString::from("argument with spaces"),
            ]
        );
        assert_eq!(command.get_env("TERM"), Some(OsStr::new("xterm-256color")));
        assert_eq!(command.get_env("COLORTERM"), Some(OsStr::new("truecolor")));
    }

    #[test]
    fn windows_terminal_command_keeps_workspace_as_one_argument() {
        let workspace = PathBuf::from("workspace with spaces");
        let terminal = |launch| ExternalTerminalSpec {
            id: "test".to_string(),
            label: "Test terminal".to_string(),
            program: PathBuf::from("terminal executable"),
            launch,
        };

        let windows = build_external_terminal_command(
            &terminal(ExternalTerminalLaunch::WindowsTerminal),
            &workspace,
        );
        assert_eq!(windows.get_current_dir(), Some(workspace.as_path()));
        assert_eq!(
            windows.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("-d"), workspace.as_os_str()]
        );
    }

    #[test]
    fn linux_terminal_commands_use_supported_working_directory_arguments() {
        let workspace = PathBuf::from("workspace with spaces");
        let terminal = |launch| ExternalTerminalSpec {
            id: "test".to_string(),
            label: "Test terminal".to_string(),
            program: PathBuf::from("terminal executable"),
            launch,
        };
        let joined = build_external_terminal_command(
            &terminal(ExternalTerminalLaunch::WorkingDirectoryArgument {
                argument: OsString::from("--working-directory="),
                joined: true,
            }),
            &workspace,
        );
        assert_eq!(
            joined.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("--working-directory=workspace with spaces")]
        );

        let separate = build_external_terminal_command(
            &terminal(ExternalTerminalLaunch::WorkingDirectoryArgument {
                argument: OsString::from("--workdir"),
                joined: false,
            }),
            &workspace,
        );
        assert_eq!(
            separate.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("--workdir"), workspace.as_os_str()]
        );

        let inherited = build_external_terminal_command(
            &terminal(ExternalTerminalLaunch::InheritWorkingDirectory),
            &workspace,
        );
        assert_eq!(inherited.get_current_dir(), Some(workspace.as_path()));
        assert_eq!(inherited.get_args().count(), 0);
    }

    #[test]
    fn mac_terminal_command_keeps_workspace_as_one_argument() {
        let workspace = PathBuf::from("workspace with spaces");
        let terminal = ExternalTerminalSpec {
            id: "test".to_string(),
            label: "Test terminal".to_string(),
            program: PathBuf::from("terminal executable"),
            launch: ExternalTerminalLaunch::MacTerminal,
        };
        let command = build_external_terminal_command(&terminal, &workspace);
        assert_eq!(command.get_current_dir(), Some(workspace.as_path()));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("-a"),
                OsStr::new("Terminal"),
                workspace.as_os_str(),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn command_prompt_disables_autorun_startup_commands() {
        let Some(command_prompt) = discover_shell_specs()
            .into_iter()
            .find(|shell| shell.id == "cmd")
        else {
            return;
        };
        assert_eq!(command_prompt.args, ["/D"]);
    }

    #[test]
    fn early_shell_exit_reports_the_code_and_recovery() {
        let message = startup_failure_message("Example shell", TerminalStartupOutcome::Exited(7));
        assert!(message.contains("code 7 (0x00000007)"));
        assert!(message.contains("Try another available shell"));
    }

    #[test]
    fn terminal_dimensions_are_bounded() {
        assert!(validate_terminal_size(80, 24).is_ok());
        assert!(validate_terminal_size(1, 24).is_err());
        assert!(validate_terminal_size(80, 0).is_err());
        assert!(validate_terminal_size(MAX_TERMINAL_COLUMNS + 1, 24).is_err());
        assert!(validate_terminal_size(80, MAX_TERMINAL_ROWS + 1).is_err());
    }

    #[test]
    fn terminal_session_ids_are_random_and_opaque() {
        let first = next_session_id().expect("a terminal session ID should be created");
        let second = next_session_id().expect("another terminal session ID should be created");
        assert!(first.starts_with("terminal-"));
        assert_eq!(first.len(), "terminal-".len() + 32);
        assert_ne!(first, second);
    }

    #[test]
    fn terminal_workspace_keys_are_stable_for_platform_paths() {
        if cfg!(windows) {
            assert_eq!(
                normalized_workspace_key(r"C:\Projects\Machdoch\"),
                "c:/projects/machdoch"
            );
            assert_eq!(
                normalized_workspace_key(r"c:/projects/machdoch"),
                "c:/projects/machdoch"
            );
            assert_eq!(
                normalized_workspace_key(r"\\?\C:\Projects\Machdoch\"),
                "c:/projects/machdoch"
            );
            assert_eq!(
                normalized_workspace_key(
                    r"Microsoft.PowerShell.Core\FileSystem::\\?\C:\Projects\Machdoch"
                ),
                "c:/projects/machdoch"
            );
            assert_eq!(
                normalized_workspace_key(r"\\?\UNC\server\share\Machdoch\"),
                "//server/share/machdoch"
            );
        } else {
            assert_eq!(normalized_workspace_key("/tmp/machdoch/"), "/tmp/machdoch");
        }
    }

    #[test]
    fn workspace_normalization_preserves_significant_whitespace() {
        let path = if cfg!(windows) {
            r"C:\Projects\ workspace "
        } else {
            "/tmp/ workspace "
        };
        assert_eq!(normalize_workspace_root_input(path), path);
        assert!(normalized_workspace_key(path).ends_with(' '));
    }

    #[test]
    fn terminal_output_flow_resumes_at_low_watermark_or_cancellation() {
        let flow = Arc::new(TerminalOutputFlow::default());
        flow.record_output(TERMINAL_OUTPUT_HIGH_WATERMARK_BYTES);
        let (finished_sender, finished_receiver) = mpsc::channel();
        let (waiting_sender, waiting_receiver) = mpsc::channel();
        let waiting_flow = Arc::clone(&flow);
        let waiter = thread::spawn(move || {
            waiting_flow.wait_for_output_capacity_when(|| {
                waiting_sender
                    .send(())
                    .expect("flow waiter should report when it is waiting");
            });
            finished_sender
                .send(())
                .expect("flow completion should send");
        });

        waiting_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("flow waiter should begin waiting");
        flow.acknowledge_output(
            TERMINAL_OUTPUT_HIGH_WATERMARK_BYTES - TERMINAL_OUTPUT_LOW_WATERMARK_BYTES - 1,
        );
        assert!(finished_receiver
            .recv_timeout(Duration::from_millis(25))
            .is_err());
        flow.acknowledge_output(1);
        finished_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("flow should resume at the low watermark");
        waiter.join().expect("flow waiter should finish");

        flow.record_output(TERMINAL_OUTPUT_HIGH_WATERMARK_BYTES);
        let (cancelled_sender, cancelled_receiver) = mpsc::channel();
        let (cancelled_waiting_sender, cancelled_waiting_receiver) = mpsc::channel();
        let waiting_flow = Arc::clone(&flow);
        let cancelled_waiter = thread::spawn(move || {
            waiting_flow.wait_for_output_capacity_when(|| {
                cancelled_waiting_sender
                    .send(())
                    .expect("cancelled flow waiter should report when it is waiting");
            });
            cancelled_sender
                .send(())
                .expect("cancelled completion should send");
        });
        cancelled_waiting_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("cancelled flow waiter should begin waiting");
        flow.cancel_output();
        cancelled_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("cancellation should unblock output immediately");
        cancelled_waiter
            .join()
            .expect("cancelled flow waiter should finish");
    }

    #[test]
    fn workspace_cleanup_keeps_other_workspace_terminals_running() {
        let shells = discover_shell_specs();
        let preferred_id = if cfg!(windows) { "cmd" } else { "sh" };
        let Some(shell) = shells
            .iter()
            .find(|shell| shell.id == preferred_id)
            .or_else(|| shells.first())
            .cloned()
        else {
            return;
        };
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let first_workspace = env::temp_dir().join(format!("machdoch-pty-first-{unique}"));
        let second_workspace = env::temp_dir().join(format!("machdoch-pty-second-{unique}"));
        fs::create_dir_all(&first_workspace).expect("first PTY workspace should create");
        fs::create_dir_all(&second_workspace).expect("second PTY workspace should create");
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let first = start_terminal_sync(
            Arc::clone(&sessions),
            StartWorkspaceTerminalRequest {
                workspace_root: first_workspace.to_string_lossy().into_owned(),
                shell_id: shell.id.clone(),
                columns: 80,
                rows: 24,
            },
            Channel::<WorkspaceTerminalEvent>::new(|_| Ok(())),
        )
        .expect("first PTY should start");
        let second = start_terminal_sync(
            Arc::clone(&sessions),
            StartWorkspaceTerminalRequest {
                workspace_root: second_workspace.to_string_lossy().into_owned(),
                shell_id: shell.id,
                columns: 80,
                rows: 24,
            },
            Channel::<WorkspaceTerminalEvent>::new(|_| Ok(())),
        )
        .expect("second PTY should start");

        assert_eq!(
            stop_workspace_terminals_sync(&sessions, &first_workspace.to_string_lossy())
                .expect("first workspace terminals should stop"),
            1
        );
        let registry = sessions.lock().expect("session registry should lock");
        assert!(!registry.contains_key(&first.session_id));
        assert!(registry.contains_key(&second.session_id));
        assert!(!registry
            .get(&second.session_id)
            .expect("second terminal should remain")
            .stopped
            .load(Ordering::SeqCst));
        drop(registry);

        assert_eq!(
            stop_workspace_terminals_sync(&sessions, &second_workspace.to_string_lossy())
                .expect("second workspace terminals should stop"),
            1
        );
        let _ = fs::remove_dir_all(first_workspace);
        let _ = fs::remove_dir_all(second_workspace);
    }

    #[test]
    fn repeated_terminal_start_stop_cycles_release_session_capacity() {
        let shells = discover_shell_specs();
        let preferred_id = if cfg!(windows) { "cmd" } else { "sh" };
        let Some(shell) = shells
            .iter()
            .find(|shell| shell.id == preferred_id)
            .or_else(|| shells.first())
            .cloned()
        else {
            return;
        };
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let workspace = env::temp_dir().join(format!("machdoch pty cycles {unique}"));
        fs::create_dir_all(&workspace).expect("cycle PTY workspace should create");
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let mut session_ids = HashSet::new();

        for _ in 0..6 {
            let started = start_terminal_sync(
                Arc::clone(&sessions),
                StartWorkspaceTerminalRequest {
                    workspace_root: workspace.to_string_lossy().into_owned(),
                    shell_id: shell.id.clone(),
                    columns: 80,
                    rows: 24,
                },
                Channel::<WorkspaceTerminalEvent>::new(|_| Ok(())),
            )
            .expect("cycle PTY should start");
            assert!(session_ids.insert(started.session_id));
            assert_eq!(
                stop_workspace_terminals_sync(&sessions, &workspace.to_string_lossy())
                    .expect("cycle PTY should stop"),
                1
            );
            assert!(sessions
                .lock()
                .expect("cycle registry should lock")
                .is_empty());
        }

        let _ = fs::remove_dir_all(workspace);
    }

    #[cfg(windows)]
    #[test]
    fn workspace_supports_mixed_powershell_and_command_prompt_sessions() {
        let shells = discover_shell_specs();
        let Some(powershell) = shells
            .iter()
            .find(|shell| shell.id == "windows-powershell")
            .or_else(|| shells.iter().find(|shell| shell.kind == "powershell"))
            .cloned()
        else {
            return;
        };
        let Some(command_prompt) = shells.iter().find(|shell| shell.id == "cmd").cloned() else {
            return;
        };
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let workspace = env::temp_dir().join(format!("machdoch pty mixed {unique}"));
        fs::create_dir_all(&workspace).expect("mixed-shell PTY workspace should create");
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let powershell_output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let callback_output = Arc::clone(&powershell_output);
        let powershell_channel = Channel::<WorkspaceTerminalEvent>::new(move |body| {
            if let WorkspaceTerminalEvent::Output { data, .. } =
                body.deserialize::<WorkspaceTerminalEvent>()?
            {
                callback_output
                    .lock()
                    .expect("PowerShell output should lock")
                    .extend(
                        BASE64_STANDARD
                            .decode(data)
                            .map_err(|error| tauri::Error::Anyhow(error.into()))?,
                    );
            }
            Ok(())
        });
        let powershell_session = start_terminal_sync(
            Arc::clone(&sessions),
            StartWorkspaceTerminalRequest {
                workspace_root: workspace.to_string_lossy().into_owned(),
                shell_id: powershell.id.clone(),
                columns: 80,
                rows: 24,
            },
            powershell_channel,
        )
        .expect("PowerShell PTY should start");
        let command_prompt_session = start_terminal_sync(
            Arc::clone(&sessions),
            StartWorkspaceTerminalRequest {
                workspace_root: workspace.to_string_lossy().into_owned(),
                shell_id: command_prompt.id.clone(),
                columns: 80,
                rows: 24,
            },
            Channel::<WorkspaceTerminalEvent>::new(|_| Ok(())),
        )
        .expect("Command Prompt PTY should start");

        assert_eq!(powershell_session.shell_id, powershell.id);
        assert_eq!(command_prompt_session.shell_id, command_prompt.id);
        assert_ne!(
            powershell_session.session_id,
            command_prompt_session.session_id
        );
        let powershell_process = sessions
            .lock()
            .expect("registry should lock")
            .get(&powershell_session.session_id)
            .cloned()
            .expect("PowerShell session should remain registered");
        let expected_workspace = shell_compatible_path(
            &workspace
                .canonicalize()
                .expect("mixed workspace should canonicalize"),
        )
        .to_string_lossy()
        .into_owned();
        let expected_marker = format!("MACHDOCH_POWERSHELL_CWD={expected_workspace}");
        let status_query_deadline = std::time::Instant::now() + Duration::from_secs(2);
        let needs_status_response = loop {
            if powershell_output
                .lock()
                .expect("PowerShell output should lock")
                .windows(4)
                .any(|bytes| bytes == b"\x1b[6n")
            {
                break true;
            }
            if std::time::Instant::now() >= status_query_deadline {
                break false;
            }
            thread::sleep(Duration::from_millis(25));
        };
        if needs_status_response {
            {
                let mut writer = powershell_process
                    .writer
                    .lock()
                    .expect("PowerShell writer should lock");
                let writer = writer.as_mut().expect("PowerShell writer should be open");
                writer
                    .write_all(b"\x1b[1;1R")
                    .expect("PowerShell status response should write");
                writer
                    .flush()
                    .expect("PowerShell status response should flush");
            }
            thread::sleep(Duration::from_millis(100));
        }
        {
            let mut writer = powershell_process
                .writer
                .lock()
                .expect("PowerShell writer should lock");
            let writer = writer.as_mut().expect("PowerShell writer should be open");
            writer
                .write_all(
                    b"Write-Output ('MACHDOCH_POWERSHELL_CWD=' + (Get-Location).ProviderPath)\r",
                )
                .expect("PowerShell cwd command should write");
            writer.flush().expect("PowerShell command should flush");
        }
        let output_deadline = std::time::Instant::now() + Duration::from_secs(8);
        while std::time::Instant::now() < output_deadline
            && !String::from_utf8_lossy(
                &powershell_output
                    .lock()
                    .expect("PowerShell output should lock"),
            )
            .to_lowercase()
            .contains(&expected_marker.to_lowercase())
        {
            thread::sleep(Duration::from_millis(25));
        }
        let captured = String::from_utf8_lossy(
            &powershell_output
                .lock()
                .expect("PowerShell output should lock"),
        )
        .into_owned();
        assert!(
            captured
                .to_lowercase()
                .contains(&expected_marker.to_lowercase()),
            "PowerShell should start in {expected_workspace:?}; captured {captured:?}"
        );
        assert!(!captured.contains(r"FileSystem::\\?\"));
        assert_eq!(sessions.lock().expect("registry should lock").len(), 2);
        assert_eq!(
            stop_workspace_terminals_sync(&sessions, &workspace.to_string_lossy())
                .expect("mixed workspace terminals should stop"),
            2
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn long_running_command_continues_until_workspace_cleanup() {
        let shells = discover_shell_specs();
        let preferred_id = if cfg!(windows) { "cmd" } else { "sh" };
        let Some(shell) = shells
            .iter()
            .find(|shell| shell.id == preferred_id)
            .or_else(|| shells.first())
            .cloned()
        else {
            return;
        };
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let workspace = env::temp_dir().join(format!("machdoch-pty-background-{unique}"));
        fs::create_dir_all(&workspace).expect("background PTY workspace should create");
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let callback_output = Arc::clone(&output);
        let channel = Channel::<WorkspaceTerminalEvent>::new(move |body| {
            if let WorkspaceTerminalEvent::Output { data, .. } =
                body.deserialize::<WorkspaceTerminalEvent>()?
            {
                callback_output
                    .lock()
                    .expect("background output should lock")
                    .extend(
                        BASE64_STANDARD
                            .decode(data)
                            .map_err(|error| tauri::Error::Anyhow(error.into()))?,
                    );
            }
            Ok(())
        });
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let started = start_terminal_sync(
            Arc::clone(&sessions),
            StartWorkspaceTerminalRequest {
                workspace_root: workspace.to_string_lossy().into_owned(),
                shell_id: shell.id,
                columns: 80,
                rows: 24,
            },
            channel,
        )
        .expect("background PTY should start");
        let session = sessions
            .lock()
            .expect("session registry should lock")
            .get(&started.session_id)
            .cloned()
            .expect("background session should be registered");
        let startup_deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < startup_deadline
            && output
                .lock()
                .expect("background output should lock")
                .is_empty()
        {
            thread::sleep(Duration::from_millis(25));
        }
        if output
            .lock()
            .expect("background output should lock")
            .windows(4)
            .any(|bytes| bytes == b"\x1b[6n")
        {
            let mut writer = session.writer.lock().expect("PTY writer should lock");
            let writer = writer.as_mut().expect("PTY writer should be open");
            writer
                .write_all(b"\x1b[1;1R")
                .expect("terminal status response should write");
            writer
                .flush()
                .expect("terminal status response should flush");
        }
        let command = if cfg!(windows) {
            b"ping -n 3 127.0.0.1 >nul & echo MACHDOCH_BACKGROUND_DONE\r".as_slice()
        } else {
            b"sleep 1; echo MACHDOCH_BACKGROUND_DONE\n".as_slice()
        };
        {
            let mut writer = session.writer.lock().expect("PTY writer should lock");
            let writer = writer.as_mut().expect("PTY writer should be open");
            writer
                .write_all(command)
                .expect("background command should write");
            writer.flush().expect("background command should flush");
        }

        thread::sleep(Duration::from_millis(200));
        assert!(sessions
            .lock()
            .expect("session registry should lock")
            .contains_key(&started.session_id));
        assert!(!session.stopped.load(Ordering::SeqCst));

        let output_deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < output_deadline
            && !String::from_utf8_lossy(&output.lock().expect("background output should lock"))
                .contains("MACHDOCH_BACKGROUND_DONE")
        {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            String::from_utf8_lossy(&output.lock().expect("background output should lock"))
                .contains("MACHDOCH_BACKGROUND_DONE"),
            "delayed terminal output should arrive while the session is in the background"
        );
        assert_eq!(
            stop_workspace_terminals_sync(&sessions, &workspace.to_string_lossy())
                .expect("background workspace terminals should stop"),
            1
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn terminal_drains_high_line_count_output_before_natural_exit() {
        let shells = discover_shell_specs();
        let preferred_id = if cfg!(windows) { "cmd" } else { "sh" };
        let Some(shell) = shells
            .iter()
            .find(|shell| shell.id == preferred_id)
            .cloned()
        else {
            return;
        };
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let workspace = env::temp_dir().join(format!("machdoch pty stress {unique}"));
        fs::create_dir_all(&workspace).expect("stress PTY workspace should create");
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let output_events = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let exit_seen = Arc::new(AtomicBool::new(false));
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let (acknowledgement_sender, acknowledgement_receiver) = mpsc::channel::<(String, usize)>();
        let acknowledgement_sessions = Arc::clone(&sessions);
        let acknowledgement_worker = thread::spawn(move || {
            while let Ok((session_id, bytes)) = acknowledgement_receiver.recv() {
                thread::sleep(Duration::from_millis(2));
                let session = acknowledgement_sessions
                    .lock()
                    .ok()
                    .and_then(|registry| registry.get(&session_id).cloned());
                if let Some(session) = session {
                    session.output_flow.acknowledge_output(bytes);
                }
            }
        });
        let callback_output = Arc::clone(&output);
        let callback_output_events = Arc::clone(&output_events);
        let callback_exit_seen = Arc::clone(&exit_seen);
        let channel = Channel::<WorkspaceTerminalEvent>::new(move |body| {
            match body.deserialize::<WorkspaceTerminalEvent>()? {
                WorkspaceTerminalEvent::Output { session_id, data } => {
                    let bytes = BASE64_STANDARD
                        .decode(data)
                        .map_err(|error| tauri::Error::Anyhow(error.into()))?;
                    callback_output_events.fetch_add(1, Ordering::SeqCst);
                    callback_output
                        .lock()
                        .expect("stress output should lock")
                        .extend(&bytes);
                    let _ = acknowledgement_sender.send((session_id, bytes.len()));
                }
                WorkspaceTerminalEvent::Exit { .. } => {
                    callback_exit_seen.store(true, Ordering::SeqCst);
                }
                WorkspaceTerminalEvent::Error { message } => {
                    callback_output
                        .lock()
                        .expect("stress output should lock")
                        .extend(message.as_bytes());
                }
            }
            Ok(())
        });
        let started = start_terminal_sync(
            Arc::clone(&sessions),
            StartWorkspaceTerminalRequest {
                workspace_root: workspace.to_string_lossy().into_owned(),
                shell_id: shell.id,
                columns: 100,
                rows: 30,
            },
            channel,
        )
        .expect("stress PTY should start");
        let session = sessions
            .lock()
            .expect("stress registry should lock")
            .get(&started.session_id)
            .cloned()
            .expect("stress session should be registered");

        #[cfg(windows)]
        {
            let status_query_deadline = std::time::Instant::now() + Duration::from_secs(2);
            while std::time::Instant::now() < status_query_deadline
                && !output
                    .lock()
                    .expect("stress output should lock")
                    .windows(4)
                    .any(|bytes| bytes == b"\x1b[6n")
            {
                thread::sleep(Duration::from_millis(20));
            }
            if output
                .lock()
                .expect("stress output should lock")
                .windows(4)
                .any(|bytes| bytes == b"\x1b[6n")
            {
                let mut writer = session.writer.lock().expect("stress writer should lock");
                let writer = writer.as_mut().expect("stress writer should be open");
                writer
                    .write_all(b"\x1b[1;1R")
                    .expect("terminal status response should write");
                writer
                    .flush()
                    .expect("terminal status response should flush");
                thread::sleep(Duration::from_millis(100));
            }
            {
                let mut writer = session.writer.lock().expect("stress writer should lock");
                let writer = writer.as_mut().expect("stress writer should be open");
                writer
                    .write_all(b"echo MACHDOCH_KEY_TST\x1b[D\x1b[DE\r")
                    .expect("editing input should write");
                writer.flush().expect("editing input should flush");
            }
            let editing_deadline = std::time::Instant::now() + Duration::from_secs(3);
            while std::time::Instant::now() < editing_deadline
                && !String::from_utf8_lossy(&output.lock().expect("stress output should lock"))
                    .contains("MACHDOCH_KEY_TEST")
            {
                thread::sleep(Duration::from_millis(20));
            }
            let editing_output =
                String::from_utf8_lossy(&output.lock().expect("stress output should lock"))
                    .into_owned();
            assert!(
                editing_output.contains("MACHDOCH_KEY_TEST"),
                "cursor-key editing should reach the shell byte-for-byte; captured {editing_output:?}"
            );

            {
                let mut writer = session.writer.lock().expect("stress writer should lock");
                let writer = writer.as_mut().expect("stress writer should be open");
                writer
                    .write_all(b"echo cancelled>machdoch-cancelled.txt\x03")
                    .expect("cancelled input should write");
                writer.flush().expect("cancelled input should flush");
            }
            thread::sleep(Duration::from_millis(100));
            {
                let mut writer = session.writer.lock().expect("stress writer should lock");
                let writer = writer.as_mut().expect("stress writer should be open");
                writer
                    .write_all(b"echo MACHDOCH_CONTROL_OK\r")
                    .expect("post-control input should write");
                writer.flush().expect("post-control input should flush");
            }
            let control_deadline = std::time::Instant::now() + Duration::from_secs(3);
            while std::time::Instant::now() < control_deadline
                && !String::from_utf8_lossy(&output.lock().expect("stress output should lock"))
                    .contains("MACHDOCH_CONTROL_OK")
            {
                thread::sleep(Duration::from_millis(20));
            }
            assert!(
                String::from_utf8_lossy(&output.lock().expect("stress output should lock"))
                    .contains("MACHDOCH_CONTROL_OK"),
                "shell input should continue after Ctrl+C"
            );
            assert!(!workspace.join("machdoch-cancelled.txt").exists());
        }

        let stress_command = if cfg!(windows) {
            b"for /L %i in (1,1,10000) do @echo MACHDOCH_STRESS_%i\recho MACHDOCH_STRESS_DONE\rexit\r"
                .as_slice()
        } else {
            b"i=1; while [ \"$i\" -le 10000 ]; do printf 'MACHDOCH_STRESS_%s\\n' \"$i\"; i=$((i+1)); done; echo MACHDOCH_STRESS_DONE; exit\n"
                .as_slice()
        };
        let stress_started = std::time::Instant::now();
        {
            let mut writer = session.writer.lock().expect("stress writer should lock");
            let writer = writer.as_mut().expect("stress writer should be open");
            writer
                .write_all(stress_command)
                .expect("stress command should write");
            writer.flush().expect("stress command should flush");
        }

        let output_deadline = std::time::Instant::now() + Duration::from_secs(30);
        while std::time::Instant::now() < output_deadline && !exit_seen.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(20));
        }
        let captured = output.lock().expect("stress output should lock").clone();
        let captured_text = String::from_utf8_lossy(&captured);
        assert!(
            captured_text.contains("MACHDOCH_STRESS_10000"),
            "the final numbered stress line should not be truncated"
        );
        assert!(
            captured_text.contains("MACHDOCH_STRESS_DONE"),
            "the final output marker should arrive before exit"
        );
        assert!(
            captured.len() > TERMINAL_OUTPUT_HIGH_WATERMARK_BYTES,
            "the stress probe should exercise output backpressure"
        );
        assert!(
            exit_seen.load(Ordering::SeqCst),
            "the natural exit event should arrive after buffered output"
        );
        eprintln!(
            "terminal stress: {} bytes in {} output events over {:?}",
            captured.len(),
            output_events.load(Ordering::SeqCst),
            stress_started.elapsed()
        );

        let cleanup_deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < cleanup_deadline
            && sessions
                .lock()
                .expect("stress registry should lock")
                .contains_key(&started.session_id)
        {
            thread::sleep(Duration::from_millis(20));
        }
        if sessions
            .lock()
            .expect("stress registry should lock")
            .contains_key(&started.session_id)
        {
            let _ = session.stop();
        }
        acknowledgement_worker
            .join()
            .expect("acknowledgement worker should finish");
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn terminal_starts_resizes_streams_and_stops() {
        let shells = discover_shell_specs();
        let preferred_id = if cfg!(windows) { "cmd" } else { "sh" };
        let Some(shell) = shells
            .iter()
            .find(|shell| shell.id == preferred_id)
            .or_else(|| shells.first())
            .cloned()
        else {
            return;
        };
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let workspace = env::temp_dir().join(format!("machdoch pty test {unique}"));
        fs::create_dir_all(&workspace).expect("PTY workspace should create");
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let callback_output = Arc::clone(&output);
        let channel = Channel::<WorkspaceTerminalEvent>::new(move |body| {
            if let WorkspaceTerminalEvent::Output { data, .. } =
                body.deserialize::<WorkspaceTerminalEvent>()?
            {
                let bytes = BASE64_STANDARD
                    .decode(data)
                    .map_err(|error| tauri::Error::Anyhow(error.into()))?;
                callback_output
                    .lock()
                    .expect("captured PTY output should lock")
                    .extend(bytes);
            }
            Ok(())
        });
        let sessions: TerminalSessions = Arc::new(Mutex::new(HashMap::new()));
        let started = start_terminal_sync(
            Arc::clone(&sessions),
            StartWorkspaceTerminalRequest {
                workspace_root: workspace.to_string_lossy().into_owned(),
                shell_id: shell.id,
                columns: 80,
                rows: 24,
            },
            channel,
        )
        .expect("PTY should start");
        let session = sessions
            .lock()
            .expect("session registry should lock")
            .get(&started.session_id)
            .cloned()
            .expect("started session should be registered");
        session
            .master
            .lock()
            .expect("PTY master should lock")
            .as_ref()
            .expect("PTY master should be open")
            .resize(validate_terminal_size(100, 30).expect("size should validate"))
            .expect("PTY should resize");

        let startup_deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < startup_deadline
            && output
                .lock()
                .expect("captured PTY output should lock")
                .is_empty()
        {
            thread::sleep(Duration::from_millis(25));
        }
        if output
            .lock()
            .expect("captured PTY output should lock")
            .windows(4)
            .any(|bytes| bytes == b"\x1b[6n")
        {
            let mut writer = session.writer.lock().expect("PTY writer should lock");
            let writer = writer.as_mut().expect("PTY writer should be open");
            writer
                .write_all(b"\x1b[1;1R")
                .expect("terminal status response should write");
            writer.flush().expect("PTY status response should flush");
        }
        let command = if cfg!(windows) {
            b"cd & echo MACHDOCH_PTY_TEST\rexit\r".as_slice()
        } else {
            b"pwd; echo MACHDOCH_PTY_TEST\nexit\n".as_slice()
        };
        {
            let mut writer = session.writer.lock().expect("PTY writer should lock");
            let writer = writer.as_mut().expect("PTY writer should be open");
            writer.write_all(command).expect("PTY input should write");
            writer.flush().expect("PTY input should flush");
        }

        let output_deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < output_deadline
            && !String::from_utf8_lossy(&output.lock().expect("captured PTY output should lock"))
                .contains("MACHDOCH_PTY_TEST")
        {
            thread::sleep(Duration::from_millis(25));
        }
        let captured_output =
            String::from_utf8_lossy(&output.lock().expect("captured PTY output should lock"))
                .into_owned();
        assert!(
            captured_output.contains("MACHDOCH_PTY_TEST"),
            "PTY output should include the command result; captured {captured_output:?}"
        );
        let expected_workspace = shell_compatible_path(
            &workspace
                .canonicalize()
                .expect("PTY workspace should canonicalize"),
        )
        .to_string_lossy()
        .into_owned();
        assert!(
            captured_output
                .to_lowercase()
                .contains(&expected_workspace.to_lowercase()),
            "PTY should start in {expected_workspace:?}; captured {captured_output:?}"
        );
        session.stop().expect("PTY should stop");

        let stop_deadline = std::time::Instant::now() + Duration::from_secs(8);
        while std::time::Instant::now() < stop_deadline {
            if sessions
                .lock()
                .expect("session registry should lock")
                .is_empty()
            {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        if let Some(session) = sessions
            .lock()
            .expect("session registry should lock")
            .remove(&started.session_id)
        {
            let _ = session.stop();
            panic!("PTY did not exit before the deadline");
        }
        let _ = fs::remove_dir_all(workspace);
    }
}
