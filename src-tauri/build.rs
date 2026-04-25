use std::{
    env, fs,
    path::{Path, PathBuf},
};

const EMBEDDED_CLI_FALLBACK: &str =
    "console.error('machdoch: bundled CLI was not built into this binary.');\nprocess.exit(1);\n";

fn find_node_binary() -> Option<PathBuf> {
    if let Some(path) = env::var_os("MACHDOCH_NODE_BINARY").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let binary_name = if cfg!(windows) { "node.exe" } else { "node" };
    let path = env::var_os("PATH")?;

    env::split_paths(&path)
        .map(|entry| entry.join(binary_name))
        .find(|candidate| candidate.is_file())
}

fn main() {
    let manifest_dir = required_env_path("CARGO_MANIFEST_DIR");
    let cli_bundle_path = manifest_dir
        .join("..")
        .join("dist")
        .join("machdoch-cli.cjs");
    let out_dir = required_env_path("OUT_DIR");
    let output_path = out_dir.join("machdoch-cli.cjs");
    let node_output_path = out_dir.join("machdoch-node.bin");

    println!("cargo:rerun-if-changed={}", cli_bundle_path.display());
    println!("cargo:rerun-if-env-changed=MACHDOCH_NODE_BINARY");
    println!("cargo:rerun-if-env-changed=PATH");

    if cli_bundle_path.is_file() {
        copy_file_or_panic(&cli_bundle_path, &output_path, "bundled CLI");
        println!("cargo:rustc-env=MACHDOCH_EMBEDDED_CLI_AVAILABLE=1");
    } else {
        write_file_or_panic(
            &output_path,
            EMBEDDED_CLI_FALLBACK.as_bytes(),
            "bundled CLI fallback",
        );
        println!("cargo:rustc-env=MACHDOCH_EMBEDDED_CLI_AVAILABLE=0");
    }

    if let Some(node_binary_path) = find_node_binary() {
        copy_file_or_panic(&node_binary_path, &node_output_path, "Node runtime");
        println!("cargo:rustc-env=MACHDOCH_EMBEDDED_NODE_AVAILABLE=1");
    } else {
        write_file_or_panic(&node_output_path, b"", "bundled Node fallback");
        println!("cargo:rustc-env=MACHDOCH_EMBEDDED_NODE_AVAILABLE=0");
    }

    tauri_build::build()
}

fn required_env_path(name: &str) -> PathBuf {
    PathBuf::from(
        env::var(name).unwrap_or_else(|error| panic!("expected Cargo to set {name}: {error}")),
    )
}

fn copy_file_or_panic(source: &Path, destination: &Path, label: &str) {
    fs::copy(source, destination).unwrap_or_else(|error| {
        panic!(
            "failed to copy {label} from {} to {}: {error}",
            source.display(),
            destination.display()
        )
    });
}

fn write_file_or_panic(path: &Path, contents: &[u8], label: &str) {
    fs::write(path, contents)
        .unwrap_or_else(|error| panic!("failed to write {label} to {}: {error}", path.display()));
}
