use std::{
    collections::{HashMap, HashSet},
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;

use base64::{
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::runtime_snapshot::resolve_workspace_root_path;

const MAX_TERMINAL_SESSIONS: usize = 8;
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_COLUMNS: u16 = 500;
const MAX_TERMINAL_ROWS: u16 = 300;
const TERMINAL_READ_BUFFER_BYTES: usize = 16 * 1024;

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
    #[cfg(windows)]
    WindowsTerminal,
    #[cfg(target_os = "macos")]
    MacTerminal,
    #[cfg(all(not(windows), not(target_os = "macos")))]
    WorkingDirectoryArgument(String),
    #[cfg(all(not(windows), not(target_os = "macos")))]
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
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkspaceTerminalEvent {
    Output { data: String },
    Exit { exit_code: Option<u32> },
    Error { message: String },
}

struct TerminalSession {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    stopped: AtomicBool,
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
        if self.stopped.swap(true, Ordering::SeqCst) {
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
        if !self.stopped.swap(true, Ordering::SeqCst) {
            if let Ok(killer) = self.killer.get_mut() {
                let _ = killer.kill();
            }
        }
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

fn canonical_workspace_root(workspace_root: &str) -> Result<PathBuf, String> {
    if workspace_root.trim().is_empty() {
        return Err("Select a workspace first.".to_string());
    }
    resolve_workspace_root_path(workspace_root)
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
        return direct.canonicalize().ok().or(Some(direct));
    }

    let paths = path_value.map(env::split_paths)?;
    let candidates = executable_candidates(program, pathext);
    for directory in paths {
        for candidate in &candidates {
            let path = directory.join(candidate);
            if is_executable_file(&path) {
                return path.canonicalize().ok().or(Some(path));
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
    is_executable_file(&path).then(|| path.canonicalize().ok().unwrap_or(path))
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
        &[],
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
        ("x-terminal-emulator", "System terminal", None),
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
    ];
    for (program_name, label, directory_argument) in candidates {
        if let Some(program) = find_executable(program_name) {
            return vec![ExternalTerminalSpec {
                id: program_name.to_string(),
                label: label.to_string(),
                program,
                launch: directory_argument
                    .map(|argument| {
                        ExternalTerminalLaunch::WorkingDirectoryArgument(argument.to_string())
                    })
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

fn start_terminal_sync(
    sessions: TerminalSessions,
    request: StartWorkspaceTerminalRequest,
    on_event: Channel<WorkspaceTerminalEvent>,
) -> Result<StartedWorkspaceTerminal, String> {
    let size = validate_terminal_size(request.columns, request.rows)?;
    let workspace = canonical_workspace_root(&request.workspace_root)?;
    let shell = discover_shell_specs()
        .into_iter()
        .find(|shell| shell.id == request.shell_id)
        .ok_or_else(|| "That shell is no longer available.".to_string())?;
    let session_id = next_session_id()?;

    if sessions
        .lock()
        .map_err(|_| "The terminal session registry is unavailable.".to_string())?
        .len()
        >= MAX_TERMINAL_SESSIONS
    {
        return Err("Close an existing terminal before starting another.".to_string());
    }

    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| format!("Unable to create a terminal: {error}"))?;
    let mut command = CommandBuilder::new(&shell.program);
    command.args(shell.args.iter());
    command.cwd(&workspace);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Unable to start {}: {error}", shell.label))?;
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
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(killer),
        stopped: AtomicBool::new(false),
    });

    {
        let mut registry = sessions
            .lock()
            .map_err(|_| "The terminal session registry is unavailable.".to_string())?;
        if registry.len() >= MAX_TERMINAL_SESSIONS {
            let _ = session.stop();
            return Err("Close an existing terminal before starting another.".to_string());
        }
        registry.insert(session_id.clone(), Arc::clone(&session));
    }

    let (worker_sender, worker_receiver) = mpsc::sync_channel::<TerminalWorkerEvent>(64);
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
            loop {
                let received = if exit_received {
                    worker_receiver
                        .recv_timeout(Duration::from_millis(150))
                        .map_err(|_| ())
                } else {
                    worker_receiver.recv().map_err(|_| ())
                };
                let Ok(event) = received else {
                    break;
                };
                match event {
                    TerminalWorkerEvent::Output(bytes) => {
                        if channel_open {
                            let data = BASE64_STANDARD.encode(bytes);
                            if !send_terminal_event(
                                &on_event,
                                WorkspaceTerminalEvent::Output { data },
                            ) {
                                channel_open = false;
                                let _ = aggregator_session.stop();
                            }
                        }
                    }
                    TerminalWorkerEvent::ReaderDone(error) => {
                        reader_done = true;
                        if channel_open {
                            if let Some(message) = error {
                                channel_open = send_terminal_event(
                                    &on_event,
                                    WorkspaceTerminalEvent::Error { message },
                                );
                            }
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
                if reader_done && exit_received {
                    break;
                }
            }
            if let Ok(mut registry) = aggregator_sessions.lock() {
                registry.remove(&aggregator_session_id);
            }
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
    thread::Builder::new()
        .name(format!("machdoch-terminal-wait-{process_id:?}"))
        .spawn(move || {
            let result = child.wait();
            wait_session.stopped.store(true, Ordering::SeqCst);
            wait_session.close_handles();
            let event = match result {
                Ok(status) => TerminalWorkerEvent::Exit {
                    exit_code: Some(status.exit_code()),
                    error: None,
                },
                Err(error) => TerminalWorkerEvent::Exit {
                    exit_code: None,
                    error: Some(format!("Unable to wait for the terminal process: {error}")),
                },
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
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Unable to write terminal input: {error}"))
    })
    .await
    .map_err(|error| format!("Terminal input stopped unexpectedly: {error}"))?
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

fn open_external_terminal_sync(workspace_root: &str, terminal_id: &str) -> Result<(), String> {
    let workspace = canonical_workspace_root(workspace_root)?;
    let terminal = discover_external_terminal_specs()
        .into_iter()
        .find(|terminal| terminal.id == terminal_id)
        .ok_or_else(|| "That external terminal is no longer available.".to_string())?;
    let mut command = Command::new(&terminal.program);
    command.current_dir(&workspace);
    match terminal.launch {
        #[cfg(windows)]
        ExternalTerminalLaunch::WindowsTerminal => {
            command.arg("-d").arg(&workspace);
        }
        #[cfg(target_os = "macos")]
        ExternalTerminalLaunch::MacTerminal => {
            command.arg("-a").arg("Terminal").arg(&workspace);
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        ExternalTerminalLaunch::WorkingDirectoryArgument(argument) => {
            if argument.ends_with('=') {
                command.arg(format!("{argument}{}", workspace.display()));
            } else {
                command.arg(argument).arg(&workspace);
            }
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        ExternalTerminalLaunch::InheritWorkingDirectory => {}
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to open {}: {error}", terminal.label))
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
        let workspace = env::temp_dir().join(format!("machdoch-pty-test-{unique}"));
        fs::create_dir_all(&workspace).expect("PTY workspace should create");
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let callback_output = Arc::clone(&output);
        let channel = Channel::<WorkspaceTerminalEvent>::new(move |body| {
            if let WorkspaceTerminalEvent::Output { data } =
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
        {
            let mut writer = session.writer.lock().expect("PTY writer should lock");
            let writer = writer.as_mut().expect("PTY writer should be open");
            writer
                .write_all(b"echo MACHDOCH_PTY_TEST\rexit\r")
                .expect("PTY input should write");
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
