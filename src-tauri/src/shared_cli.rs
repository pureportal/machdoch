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
    temporary_paths: Vec<PathBuf>,
}

impl Drop for SharedCliCommand {
    fn drop(&mut self) {
        for path in &self.temporary_paths {
            let _ = fs::remove_file(path);
        }
    }
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

    Some(SharedCliCommand {
        command,
        temporary_paths: Vec::new(),
    })
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
    let entry_path = match write_embedded_cli_entry() {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_file(&node_path);
            return Err(error);
        }
    };
    let mut command = Command::new(&node_path);
    command.arg(&entry_path).args(args);

    Ok(SharedCliCommand {
        command,
        temporary_paths: vec![entry_path, node_path],
    })
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
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let entry_path = get_runtime_directory()?.join(format!(
        "machdoch-cli-{}-{}-{timestamp}.cjs",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
    ));

    fs::write(&entry_path, EMBEDDED_CLI_BUNDLE).map_err(|error| {
        format!(
            "Failed to materialize the bundled CLI at {}: {error}",
            entry_path.display()
        )
    })?;

    Ok(entry_path)
}

fn write_embedded_node_runtime() -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let node_path = get_runtime_directory()?.join(format!(
        "machdoch-node-{}-{}-{timestamp}{suffix}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
    ));

    fs::write(&node_path, EMBEDDED_NODE_BINARY).map_err(|error| {
        format!(
            "Failed to materialize the bundled Node.js runtime at {}: {error}",
            node_path.display()
        )
    })?;

    make_executable(&node_path)?;

    Ok(node_path)
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
