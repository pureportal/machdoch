use std::{
    env,
    io::{Read, Write as _},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(any(machdoch_embedded_runtime, test))]
use std::{fs, fs::File, path::Path};

use serde_json::Value;
#[cfg(any(machdoch_embedded_runtime, test))]
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

#[cfg(any(machdoch_embedded_runtime, test))]
use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};
use crate::child_process::SupervisedChild;
#[cfg(any(machdoch_embedded_runtime, test))]
use crate::cooperative_file_lock::with_cooperative_file_lock;

#[cfg(all(unix, any(machdoch_embedded_runtime, test)))]
use std::os::unix::fs::PermissionsExt;

#[cfg(machdoch_embedded_runtime)]
const EMBEDDED_CLI_BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/machdoch-cli.cjs"));
#[cfg(machdoch_embedded_runtime)]
const EMBEDDED_NODE_BINARY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/machdoch-node.bin"));
#[cfg(machdoch_embedded_runtime)]
const EMBEDDED_BROWSER_RUNTIME: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/machdoch-browser-runtime.tar.gz"));
const BUILD_NODE_REQUIREMENT: &str = "Node.js >= 20.10";
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
            "The shared CLI bundle is unavailable. Build it with pnpm build:cli-bundle before starting the development desktop.".to_string()
        })
    }
}

fn read_bounded_cli_stream(mut stream: impl Read, stream_name: &str) -> Result<Vec<u8>, String> {
    let capture_limit = MAX_SIDE_EFFECT_FREE_CLI_OUTPUT_BYTES as usize;
    let mut bytes = Vec::with_capacity(capture_limit.min(8192));
    let mut exceeded_limit = false;
    let mut buffer = [0_u8; 8192];

    loop {
        let bytes_read = stream
            .read(&mut buffer)
            .map_err(|_| format!("The shared CLI {stream_name} stream could not be read."))?;
        if bytes_read == 0 {
            break;
        }

        let remaining = capture_limit.saturating_add(1).saturating_sub(bytes.len());
        if remaining > 0 {
            bytes.extend_from_slice(&buffer[..bytes_read.min(remaining)]);
        }
        exceeded_limit |= bytes_read > remaining || bytes.len() > capture_limit;
    }

    if exceeded_limit {
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
        .map_err(|_| "The shared CLI validator input worker stopped unexpectedly.".to_string());
    let stdout_result = stdout_worker
        .join()
        .map_err(|_| "The shared CLI validator output worker stopped unexpectedly.".to_string());
    let stderr_result = stderr_worker
        .join()
        .map_err(|_| "The shared CLI validator error worker stopped unexpectedly.".to_string());
    let input_result = input_result?;
    let stdout = Zeroizing::new(stdout_result??);
    let _stderr = Zeroizing::new(stderr_result??);
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
    let cli_entry_path = repo_root.join("dist").join("machdoch-cli.cjs");

    if !cli_entry_path.is_file() {
        return None;
    }

    let mut command = Command::new("node");
    command
        .current_dir(repo_root)
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
    let directory = get_runtime_directory()?.join(format!(
        "machdoch-cli-{}-{:016x}-{:016x}",
        env!("CARGO_PKG_VERSION"),
        stable_content_hash(EMBEDDED_CLI_BUNDLE.as_bytes()),
        stable_content_hash(EMBEDDED_BROWSER_RUNTIME),
    ));
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;
    let entry_path = directory.join("machdoch-cli.cjs");
    with_cooperative_file_lock(&entry_path, || {
        crate::embedded_browser_runtime::materialize_browser_runtime(
            &directory,
            EMBEDDED_BROWSER_RUNTIME,
        )?;
        materialize_cached_runtime_file_contents(&entry_path, EMBEDDED_CLI_BUNDLE.as_bytes(), false)
    })?;
    Ok(entry_path)
}

#[cfg(machdoch_embedded_runtime)]
fn write_embedded_node_runtime() -> Result<PathBuf, String> {
    materialize_cached_runtime_file(
        || {
            let suffix = if cfg!(windows) { ".exe" } else { "" };
            format!(
                "machdoch-node-{}-{:016x}{suffix}",
                env!("CARGO_PKG_VERSION"),
                stable_content_hash(EMBEDDED_NODE_BINARY),
            )
        },
        EMBEDDED_NODE_BINARY,
        true,
    )
}

#[cfg(machdoch_embedded_runtime)]
fn materialize_cached_runtime_file(
    create_file_name: impl FnOnce() -> String,
    contents: &[u8],
    executable: bool,
) -> Result<PathBuf, String> {
    let runtime_directory = get_runtime_directory()?;
    materialize_cached_runtime_file_in_directory(
        &runtime_directory,
        &create_file_name(),
        contents,
        executable,
    )
}

#[cfg(any(machdoch_embedded_runtime, test))]
fn materialize_cached_runtime_file_in_directory(
    runtime_directory: &Path,
    file_name: &str,
    contents: &[u8],
    executable: bool,
) -> Result<PathBuf, String> {
    let runtime_path = runtime_directory.join(file_name);
    with_cooperative_file_lock(&runtime_path, || {
        materialize_cached_runtime_file_contents(&runtime_path, contents, executable)
    })?;

    Ok(runtime_path)
}

#[cfg(any(machdoch_embedded_runtime, test))]
fn materialize_cached_runtime_file_contents(
    runtime_path: &Path,
    contents: &[u8],
    executable: bool,
) -> Result<bool, String> {
    if cached_runtime_file_matches(runtime_path, contents) {
        if executable {
            make_executable(runtime_path)?;
        }
        return Ok(false);
    }

    let options = if executable {
        AtomicWriteOptions::with_unix_mode(0o700)
    } else {
        AtomicWriteOptions::default()
    };
    if let Err(error) = write_file_atomic(runtime_path, contents, options) {
        if !cached_runtime_file_matches(runtime_path, contents) {
            return Err(format!(
                "Failed to materialize the bundled CLI runtime file at {}: {error}",
                runtime_path.display()
            ));
        }
    }

    if executable {
        make_executable(runtime_path)?;
    }

    Ok(true)
}

#[cfg(any(machdoch_embedded_runtime, test))]
fn cached_runtime_file_matches(runtime_path: &Path, contents: &[u8]) -> bool {
    let Ok(metadata) = fs::symlink_metadata(runtime_path) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }

    let Ok(mut file) = File::open(runtime_path) else {
        return false;
    };
    let expected_hash = Sha256::digest(contents);
    let mut actual_hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let Ok(read) = file.read(&mut buffer) else {
            return false;
        };
        if read == 0 {
            break;
        }
        actual_hash.update(&buffer[..read]);
    }

    actual_hash.finalize().as_slice() == expected_hash.as_slice()
}

#[cfg(any(machdoch_embedded_runtime, test))]
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

        if permissions.mode() & 0o777 != 0o700 {
            permissions.set_mode(0o700);
            fs::set_permissions(&runtime_directory, permissions).map_err(|error| {
                format!(
                    "Failed to secure the bundled CLI runtime directory {}: {error}",
                    runtime_directory.display()
                )
            })?;
        }
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

#[cfg(any(machdoch_embedded_runtime, test))]
fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();

        if permissions.mode() & 0o777 != 0o700 {
            permissions.set_mode(0o700);
            fs::set_permissions(path, permissions).map_err(|error| {
                format!("Failed to mark {} executable: {error}", path.display())
            })?;
        }
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
    use std::{
        env, fs, io,
        path::{Path, PathBuf},
        process::Command,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        },
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use zeroize::Zeroizing;

    use super::{
        materialize_cached_runtime_file_contents, materialize_cached_runtime_file_in_directory,
        read_bounded_cli_stream, run_side_effect_free_json_command_with_command,
        sanitize_node_options, MAX_SIDE_EFFECT_FREE_CLI_OUTPUT_BYTES,
    };

    const TEST_CHILD_MODE_ENV: &str = "MACHDOCH_SHARED_CLI_TEST_CHILD_MODE";

    struct TrackingReader {
        bytes: io::Cursor<Vec<u8>>,
        bytes_read: Arc<AtomicUsize>,
    }

    impl io::Read for TrackingReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let bytes_read = self.bytes.read(buffer)?;
            self.bytes_read.fetch_add(bytes_read, Ordering::SeqCst);
            Ok(bytes_read)
        }
    }

    fn test_child_command(mode: &str) -> Command {
        let mut command = Command::new(env::current_exe().expect("test executable should resolve"));
        command
            .arg("--exact")
            .arg("shared_cli::tests::shared_cli_supervision_test_entrypoint")
            .arg("--nocapture")
            .env(TEST_CHILD_MODE_ENV, mode);
        command
    }

    fn temp_runtime_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("machdoch-shared-cli-{name}-{unique}"))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
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
    fn oversized_cli_output_is_drained_without_unbounded_capture() {
        let output_size = MAX_SIDE_EFFECT_FREE_CLI_OUTPUT_BYTES as usize + 16 * 1024;
        let bytes_read = Arc::new(AtomicUsize::new(0));
        let reader = TrackingReader {
            bytes: io::Cursor::new(vec![b'x'; output_size]),
            bytes_read: Arc::clone(&bytes_read),
        };

        let error = read_bounded_cli_stream(reader, "stdout")
            .expect_err("oversized output should be rejected");

        assert!(error.contains("exceeded its bounded output limit"));
        assert_eq!(bytes_read.load(Ordering::SeqCst), output_size);
    }

    #[test]
    fn valid_cached_runtime_file_is_reused_without_replacement() {
        let directory = temp_runtime_directory("reuse");
        let runtime_path = directory.join("machdoch-cli-test.cjs");
        let contents = b"console.log('runtime');";
        fs::create_dir_all(&directory).expect("test runtime directory should be created");
        fs::write(&runtime_path, contents).expect("cached runtime should be written");

        let replaced = materialize_cached_runtime_file_contents(&runtime_path, contents, false)
            .expect("valid cached runtime should be reused");

        assert!(!replaced);
        assert_eq!(
            fs::read(&runtime_path).expect("cached runtime should remain readable"),
            contents
        );
        cleanup(&directory);
    }

    #[test]
    fn distinct_cached_runtime_artifacts_remain_available() {
        let directory = temp_runtime_directory("coexisting-artifacts");
        fs::create_dir_all(&directory).expect("test runtime directory should be created");

        let first_path = materialize_cached_runtime_file_in_directory(
            &directory,
            "machdoch-cli-10.0.0-first.cjs",
            b"console.log('first runtime');",
            false,
        )
        .expect("first runtime should be materialized");
        let second_path = materialize_cached_runtime_file_in_directory(
            &directory,
            "machdoch-cli-10.0.0-second.cjs",
            b"console.log('second runtime');",
            false,
        )
        .expect("second runtime should be materialized");

        assert_eq!(
            fs::read(first_path).expect("first runtime should remain readable"),
            b"console.log('first runtime');"
        );
        assert_eq!(
            fs::read(second_path).expect("second runtime should remain readable"),
            b"console.log('second runtime');"
        );
        cleanup(&directory);
    }

    #[test]
    fn mismatched_cached_runtime_file_is_replaced_atomically() {
        let directory = temp_runtime_directory("repair");
        let runtime_path = directory.join("machdoch-node-test.bin");
        let contents = b"complete embedded runtime";
        fs::create_dir_all(&directory).expect("test runtime directory should be created");
        fs::write(&runtime_path, b"truncated").expect("invalid cached runtime should be written");

        let replaced = materialize_cached_runtime_file_contents(&runtime_path, contents, false)
            .expect("invalid cached runtime should be repaired");

        assert!(replaced);
        assert_eq!(
            fs::read(&runtime_path).expect("repaired runtime should be readable"),
            contents
        );
        cleanup(&directory);
    }

    #[test]
    fn concurrent_runtime_materialization_is_idempotent() {
        let directory = temp_runtime_directory("concurrent");
        let file_name = Arc::new("machdoch-node-test.bin".to_string());
        let contents = Arc::new(b"complete embedded runtime".to_vec());
        let contenders = 4;
        let barrier = Arc::new(Barrier::new(contenders));
        fs::create_dir_all(&directory).expect("test runtime directory should be created");

        let workers = (0..contenders)
            .map(|_| {
                let directory = directory.clone();
                let file_name = Arc::clone(&file_name);
                let contents = Arc::clone(&contents);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    materialize_cached_runtime_file_in_directory(
                        &directory, &file_name, &contents, false,
                    )
                })
            })
            .collect::<Vec<_>>();

        let paths = workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .expect("materialization worker should not panic")
                    .expect("materialization worker should succeed")
            })
            .collect::<Vec<_>>();

        assert!(paths
            .iter()
            .all(|path| path == &directory.join(file_name.as_str())));
        assert_eq!(
            fs::read(directory.join(file_name.as_str())).expect("final runtime should be readable"),
            *contents
        );
        assert!(fs::read_dir(&directory)
            .expect("runtime directory should be readable")
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .contains(".machdoch.lock")));
        cleanup(&directory);
    }

    #[test]
    fn runtime_materialization_waits_for_the_artifact_lock() {
        let directory = temp_runtime_directory("artifact-lock");
        let file_name = "machdoch-node-test.bin";
        let runtime_path = directory.join(file_name);
        let contents = b"complete embedded runtime";
        fs::create_dir_all(&directory).expect("runtime directory should be created");
        let lock = crate::cooperative_file_lock::acquire_cooperative_file_lock(&runtime_path)
            .expect("artifact lock should be acquired");
        let worker_directory = directory.clone();
        let worker = thread::spawn(move || {
            materialize_cached_runtime_file_in_directory(
                &worker_directory,
                file_name,
                contents,
                false,
            )
        });

        thread::sleep(Duration::from_millis(50));
        assert!(!worker.is_finished());
        drop(lock);
        let materialized = worker
            .join()
            .expect("materialization worker should not panic")
            .expect("materialization worker should complete after lock release");

        assert_eq!(materialized, runtime_path);
        assert_eq!(
            fs::read(&materialized).expect("materialized runtime should be readable"),
            contents
        );
        cleanup(&directory);
    }
}
