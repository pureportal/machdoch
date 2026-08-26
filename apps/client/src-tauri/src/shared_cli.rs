use std::{
    env,
    io::{Read, Write as _},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(machdoch_embedded_runtime)]
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use zeroize::Zeroizing;

use crate::child_process::SupervisedChild;

#[cfg(all(unix, machdoch_embedded_runtime))]
use std::os::unix::fs::PermissionsExt;

#[cfg(machdoch_embedded_runtime)]
const EMBEDDED_CLI_BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/machdoch-cli.cjs"));
#[cfg(machdoch_embedded_runtime)]
const EMBEDDED_NODE_BINARY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/machdoch-node.bin"));
const BUILD_NODE_REQUIREMENT: &str = "Node.js >= 20.10";
#[cfg(machdoch_embedded_runtime)]
const RETAINED_PREVIOUS_RUNTIME_FILES_PER_FAMILY: usize = 1;
const MAX_SIDE_EFFECT_FREE_CLI_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) struct SharedCliCommand {
    pub(crate) command: Command,
}

pub(crate) fn create_shared_cli_command(args: &[String]) -> Result<SharedCliCommand, String> {
    #[cfg(machdoch_embedded_runtime)]
    {
        create_embedded_cli_command(args)
    }

    #[cfg(not(machdoch_embedded_runtime))]
    {
        create_source_cli_command(args).ok_or_else(|| {
            "The shared CLI is unavailable because this development build has no embedded runtime and is not running from a source checkout.".to_string()
        })
    }
}

fn read_bounded_cli_stream(mut stream: impl Read, stream_name: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    stream
        .by_ref()
        .take(MAX_SIDE_EFFECT_FREE_CLI_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("The shared CLI {stream_name} stream could not be read."))?;
    if bytes.len() as u64 > MAX_SIDE_EFFECT_FREE_CLI_OUTPUT_BYTES {
        return Err(format!(
            "The shared CLI {stream_name} stream exceeded its bounded output limit."
        ));
    }
    Ok(bytes)
}

pub(crate) fn run_side_effect_free_json_command(
    args: &[String],
    input: Zeroizing<Vec<u8>>,
    command_timeout: Duration,
) -> Result<Value, String> {
    let shared = create_shared_cli_command(args)?;
    run_side_effect_free_json_command_with_command(
        shared.command,
        input,
        command_timeout,
        SupervisedChild::try_wait,
    )
}

fn run_side_effect_free_json_command_with_command(
    mut command: Command,
    input: Zeroizing<Vec<u8>>,
    command_timeout: Duration,
    mut monitor: impl FnMut(&mut SupervisedChild) -> std::io::Result<Option<std::process::ExitStatus>>,
) -> Result<Value, String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = SupervisedChild::spawn(&mut command)
        .map_err(|_| "The side-effect-free shared CLI validator could not start.".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "The shared CLI validator did not expose stdin.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The shared CLI validator did not expose stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "The shared CLI validator did not expose stderr.".to_string())?;
    let input_worker = thread::spawn(move || {
        let result = stdin.write_all(&input).and_then(|()| stdin.flush());
        drop(stdin);
        result.map_err(|_| "The shared CLI validator input could not be written.".to_string())
    });
    let stdout_worker = thread::spawn(move || read_bounded_cli_stream(stdout, "stdout"));
    let stderr_worker = thread::spawn(move || read_bounded_cli_stream(stderr, "stderr"));
    let started_at = Instant::now();
    let status = loop {
        match monitor(&mut child) {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started_at.elapsed() >= command_timeout => {
                let _ = child.terminate_and_reap();
                break Err("The shared CLI validator exceeded its safety timeout.".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => {
                let _ = child.terminate_and_reap();
                break Err("The shared CLI validator could not be monitored.".to_string());
            }
        }
    };
    let input_result = input_worker
        .join()
        .map_err(|_| "The shared CLI validator input worker stopped unexpectedly.".to_string())?;
    let stdout = Zeroizing::new(stdout_worker.join().map_err(|_| {
        "The shared CLI validator output worker stopped unexpectedly.".to_string()
    })??);
    let _stderr = Zeroizing::new(stderr_worker.join().map_err(|_| {
        "The shared CLI validator error worker stopped unexpectedly.".to_string()
    })??);
    let status = status?;
    if !status.success() {
        return Err("The shared CLI rejected the settings validation request.".to_string());
    }
    input_result?;
    serde_json::from_slice::<Value>(&stdout)
        .map_err(|_| "The shared CLI validator returned invalid JSON.".to_string())
}

#[cfg(not(machdoch_embedded_runtime))]
fn create_source_cli_command(args: &[String]) -> Option<SharedCliCommand> {
    let repo_root = resolve_repo_root()?;
    let cli_entry_path = repo_root.join("src").join("cli").join("main.ts");

    if !cli_entry_path.is_file() {
        return None;
    }

    let mut command = Command::new("node");
    command
        .current_dir(repo_root)
        .arg("--import")
        .arg("@oxc-node/core/register")
        .arg(cli_entry_path)
        .args(args);
    sanitize_node_debug_environment(&mut command);

    Some(SharedCliCommand { command })
}

#[cfg(machdoch_embedded_runtime)]
fn create_embedded_cli_command(args: &[String]) -> Result<SharedCliCommand, String> {
    let node_path = write_embedded_node_runtime()?;
    let entry_path = write_embedded_cli_entry()?;
    let mut command = Command::new(&node_path);
    command.arg(&entry_path).args(args);
    sanitize_node_debug_environment(&mut command);

    Ok(SharedCliCommand { command })
}

fn sanitize_node_debug_environment(command: &mut Command) {
    if let Ok(node_options) = env::var("NODE_OPTIONS") {
        match sanitize_node_options(&node_options) {
            Some(sanitized_options) => {
                command.env("NODE_OPTIONS", sanitized_options);
            }
            None => {
                command.env_remove("NODE_OPTIONS");
            }
        }
    }

    command.env_remove("VSCODE_INSPECTOR_OPTIONS");
}

fn sanitize_node_options(value: &str) -> Option<String> {
    let sanitized_options = value
        .split_whitespace()
        .filter(|option| !option.starts_with("--inspect"))
        .collect::<Vec<_>>()
        .join(" ");

    if sanitized_options.is_empty() {
        None
    } else {
        Some(sanitized_options)
    }
}

#[cfg(not(machdoch_embedded_runtime))]
fn resolve_repo_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|parent| parent.to_path_buf())
}

#[cfg(machdoch_embedded_runtime)]
fn write_embedded_cli_entry() -> Result<PathBuf, String> {
    let file_name = format!(
        "machdoch-cli-{}-{:016x}.cjs",
        env!("CARGO_PKG_VERSION"),
        stable_content_hash(EMBEDDED_CLI_BUNDLE.as_bytes()),
    );

    materialize_cached_runtime_file(file_name, EMBEDDED_CLI_BUNDLE.as_bytes(), false)
}

#[cfg(machdoch_embedded_runtime)]
fn write_embedded_node_runtime() -> Result<PathBuf, String> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let file_name = format!(
        "machdoch-node-{}-{:016x}{suffix}",
        env!("CARGO_PKG_VERSION"),
        stable_content_hash(EMBEDDED_NODE_BINARY),
    );

    materialize_cached_runtime_file(file_name, EMBEDDED_NODE_BINARY, true)
}

#[cfg(machdoch_embedded_runtime)]
fn materialize_cached_runtime_file(
    file_name: String,
    contents: &[u8],
    executable: bool,
) -> Result<PathBuf, String> {
    let runtime_directory = get_runtime_directory()?;
    let runtime_path = runtime_directory.join(&file_name);

    if runtime_path.is_file() {
        if executable {
            make_executable(&runtime_path)?;
        }

        cleanup_cached_runtime_files(&runtime_directory, &file_name);
        return Ok(runtime_path);
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temporary_path = runtime_directory.join(format!(
        ".{file_name}.{}.{timestamp}.tmp",
        std::process::id(),
    ));

    fs::write(&temporary_path, contents).map_err(|error| {
        format!(
            "Failed to materialize the bundled CLI runtime file at {}: {error}",
            temporary_path.display()
        )
    })?;

    if executable {
        make_executable(&temporary_path)?;
    }

    match fs::rename(&temporary_path, &runtime_path) {
        Ok(()) => {}
        Err(_) if runtime_path.is_file() => {
            let _ = fs::remove_file(&temporary_path);

            if executable {
                make_executable(&runtime_path)?;
            }
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);

            return Err(format!(
                "Failed to move the bundled CLI runtime file from {} to {}: {error}",
                temporary_path.display(),
                runtime_path.display(),
            ));
        }
    }

    cleanup_cached_runtime_files(&runtime_directory, &file_name);
    Ok(runtime_path)
}

#[cfg(machdoch_embedded_runtime)]
fn cleanup_cached_runtime_files(runtime_directory: &Path, current_file_name: &str) {
    let Some(family_prefix) = cached_runtime_file_family(current_file_name) else {
        return;
    };
    let Ok(entries) = fs::read_dir(runtime_directory) else {
        return;
    };
    let mut previous_files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let file_name = file_name.to_str()?;

            if file_name == current_file_name || !file_name.starts_with(family_prefix) {
                return None;
            }

            let path = entry.path();
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect::<Vec<_>>();

    previous_files.sort_by_key(|entry| std::cmp::Reverse(entry.0));

    for (_, stale_path) in previous_files
        .into_iter()
        .skip(RETAINED_PREVIOUS_RUNTIME_FILES_PER_FAMILY)
    {
        let _ = fs::remove_file(stale_path);
    }
}

#[cfg(any(machdoch_embedded_runtime, test))]
fn cached_runtime_file_family(file_name: &str) -> Option<&'static str> {
    if file_name.starts_with("machdoch-node-") {
        return Some("machdoch-node-");
    }

    if file_name.starts_with("machdoch-cli-") {
        return Some("machdoch-cli-");
    }

    None
}

#[cfg(machdoch_embedded_runtime)]
fn stable_content_hash(contents: &[u8]) -> u64 {
    contents.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[cfg(machdoch_embedded_runtime)]
fn get_runtime_directory() -> Result<PathBuf, String> {
    let base_directory = resolve_runtime_base_directory();
    let runtime_directory = base_directory.join("machdoch").join("runtime");

    fs::create_dir_all(&runtime_directory).map_err(|error| {
        format!(
            "Failed to create the bundled CLI runtime directory {}: {error}",
            runtime_directory.display()
        )
    })?;

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&runtime_directory)
            .map_err(|error| format!("Failed to inspect {}: {error}", runtime_directory.display()))?
            .permissions();

        permissions.set_mode(0o700);
        fs::set_permissions(&runtime_directory, permissions).map_err(|error| {
            format!(
                "Failed to secure the bundled CLI runtime directory {}: {error}",
                runtime_directory.display()
            )
        })?;
    }

    Ok(runtime_directory)
}

#[cfg(machdoch_embedded_runtime)]
fn resolve_runtime_base_directory() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            return path;
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(path) = env::var_os("HOME").map(PathBuf::from) {
            return path.join("Library").join("Caches");
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(path) = env::var_os("XDG_CACHE_HOME").map(PathBuf::from) {
            return path;
        }

        if let Some(path) = env::var_os("HOME").map(PathBuf::from) {
            return path.join(".cache");
        }
    }

    env::temp_dir()
}

#[cfg(machdoch_embedded_runtime)]
fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();

        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to mark {} executable: {error}", path.display()))?;
    }

    #[cfg(not(unix))]
    {
        let _ = path;
    }

    Ok(())
}

pub(crate) fn cli_runtime_error_hint() -> String {
    format!(
        "The bundled CLI runtime could not start. In development, ensure {BUILD_NODE_REQUIREMENT} is installed and available on PATH; for release builds, ensure Node was available at build time or set MACHDOCH_NODE_BINARY."
    )
}

#[cfg(test)]
mod tests {
    use std::{env, io, process::Command, thread, time::Duration};

    use zeroize::Zeroizing;

    use super::{
        cached_runtime_file_family, run_side_effect_free_json_command_with_command,
        sanitize_node_options,
    };

    const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_SHARED_CLI_TEST_CHILD_MODE";

    fn test_child_command(mode: &str) -> Command {
        let mut command = Command::new(env::current_exe().expect("test executable should resolve"));
        command
            .arg("--exact")
            .arg("shared_cli::tests::shared_cli_supervision_test_entrypoint")
            .arg("--nocapture")
            .env(TEST_CHILD_MODE_ENV, mode);
        command
    }

    #[test]
    fn shared_cli_supervision_test_entrypoint() {
        match env::var(TEST_CHILD_MODE_ENV).as_deref() {
            Ok("json") => println!("{{\"ok\":true}}"),
            Ok("hold") => thread::sleep(Duration::from_secs(60)),
            _ => {}
        }
    }

    #[test]
    fn side_effect_free_validator_timeout_stops_and_joins_child_workers() {
        let error = run_side_effect_free_json_command_with_command(
            test_child_command("hold"),
            Zeroizing::new(b"{}".to_vec()),
            Duration::from_millis(100),
            crate::child_process::SupervisedChild::try_wait,
        )
        .expect_err("hanging validator should time out");

        assert_eq!(
            error,
            "The shared CLI validator exceeded its safety timeout."
        );
    }

    #[test]
    fn side_effect_free_validator_monitor_failure_stops_and_joins_child_workers() {
        let error = run_side_effect_free_json_command_with_command(
            test_child_command("hold"),
            Zeroizing::new(b"{}".to_vec()),
            Duration::from_secs(5),
            |_| Err(io::Error::other("simulated monitor failure")),
        )
        .expect_err("monitor failure should stop the validator");

        assert_eq!(error, "The shared CLI validator could not be monitored.");
    }

    #[test]
    fn shared_cli_node_options_strip_debug_inspect_flags() {
        assert_eq!(
            sanitize_node_options("--inspect=127.0.0.1:9229 --max-old-space-size=4096"),
            Some("--max-old-space-size=4096".to_string()),
        );
        assert_eq!(sanitize_node_options("--inspect-brk"), None);
    }

    #[test]
    fn cached_runtime_files_are_grouped_without_matching_unrelated_files() {
        assert_eq!(
            cached_runtime_file_family("machdoch-node-0.30.5-hash.exe"),
            Some("machdoch-node-")
        );
        assert_eq!(
            cached_runtime_file_family("machdoch-cli-0.30.5-hash.cjs"),
            Some("machdoch-cli-")
        );
        assert_eq!(cached_runtime_file_family("notes.txt"), None);
    }
}
