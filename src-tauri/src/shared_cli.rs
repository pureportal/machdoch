use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const EMBEDDED_CLI_BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/machdoch-cli.cjs"));
const EMBEDDED_NODE_BINARY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/machdoch-node.bin"));
const BUILD_NODE_REQUIREMENT: &str = "Node.js >= 20.10";

pub(crate) struct SharedCliCommand {
    pub(crate) command: Command,
}

pub(crate) fn create_shared_cli_command(args: &[String]) -> Result<SharedCliCommand, String> {
    if !cfg!(debug_assertions) {
        if let Ok(command) = create_embedded_cli_command(args) {
            return Ok(command);
        }
    }

    if let Some(command) = create_source_cli_command(args) {
        return Ok(command);
    }

    create_embedded_cli_command(args)
}

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
        .arg("tsx")
        .arg(cli_entry_path)
        .args(args);
    sanitize_node_debug_environment(&mut command);

    Some(SharedCliCommand { command })
}

fn create_embedded_cli_command(args: &[String]) -> Result<SharedCliCommand, String> {
    if !embedded_cli_available() {
        return Err(
            "The bundled CLI is not available in this build. Run `npm run build:cli-bundle` before building the Tauri release, or run from a source checkout with `npm install`.".to_string(),
        );
    }

    if !embedded_node_available() {
        return Err(format!(
            "The bundled Node.js runtime is not available in this build. Ensure {BUILD_NODE_REQUIREMENT} is available while building machdoch, or set MACHDOCH_NODE_BINARY to a Node executable to embed."
        ));
    }

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

fn embedded_cli_available() -> bool {
    option_env!("MACHDOCH_EMBEDDED_CLI_AVAILABLE") == Some("1")
}

fn embedded_node_available() -> bool {
    option_env!("MACHDOCH_EMBEDDED_NODE_AVAILABLE") == Some("1") && !EMBEDDED_NODE_BINARY.is_empty()
}

fn resolve_repo_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
}

fn write_embedded_cli_entry() -> Result<PathBuf, String> {
    let file_name = format!(
        "machdoch-cli-{}-{:016x}.cjs",
        env!("CARGO_PKG_VERSION"),
        stable_content_hash(EMBEDDED_CLI_BUNDLE.as_bytes()),
    );

    materialize_cached_runtime_file(file_name, EMBEDDED_CLI_BUNDLE.as_bytes(), false)
}

fn write_embedded_node_runtime() -> Result<PathBuf, String> {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let file_name = format!(
        "machdoch-node-{}-{:016x}{suffix}",
        env!("CARGO_PKG_VERSION"),
        stable_content_hash(EMBEDDED_NODE_BINARY),
    );

    materialize_cached_runtime_file(file_name, EMBEDDED_NODE_BINARY, true)
}

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

    Ok(runtime_path)
}

fn stable_content_hash(contents: &[u8]) -> u64 {
    contents.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

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
    use super::sanitize_node_options;

    #[test]
    fn shared_cli_node_options_strip_debug_inspect_flags() {
        assert_eq!(
            sanitize_node_options("--inspect=127.0.0.1:9229 --max-old-space-size=4096"),
            Some("--max-old-space-size=4096".to_string()),
        );
        assert_eq!(sanitize_node_options("--inspect-brk"), None);
    }
}
