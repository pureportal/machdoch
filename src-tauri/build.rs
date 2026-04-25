use std::{env, fs, path::PathBuf};

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
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let cli_bundle_path = manifest_dir
        .join("..")
        .join("dist")
        .join("machdoch-cli.cjs");
    let output_path = PathBuf::from(env::var("OUT_DIR").unwrap()).join("machdoch-cli.cjs");
    let node_output_path = PathBuf::from(env::var("OUT_DIR").unwrap()).join("machdoch-node.bin");

    println!("cargo:rerun-if-changed={}", cli_bundle_path.display());
    println!("cargo:rerun-if-env-changed=MACHDOCH_NODE_BINARY");
    println!("cargo:rerun-if-env-changed=PATH");

    if cli_bundle_path.is_file() {
        fs::copy(&cli_bundle_path, &output_path).unwrap_or_else(|error| {
            panic!(
                "failed to copy bundled CLI from {} to {}: {error}",
                cli_bundle_path.display(),
                output_path.display()
            )
        });
        println!("cargo:rustc-env=MACHDOCH_EMBEDDED_CLI_AVAILABLE=1");
    } else {
        fs::write(
            &output_path,
            "console.error('machdoch: bundled CLI was not built into this binary.');\nprocess.exit(1);\n",
        )
        .unwrap_or_else(|error| {
            panic!(
                "failed to write bundled CLI fallback to {}: {error}",
                output_path.display()
            )
        });
        println!("cargo:rustc-env=MACHDOCH_EMBEDDED_CLI_AVAILABLE=0");
    }

    if let Some(node_binary_path) = find_node_binary() {
        fs::copy(&node_binary_path, &node_output_path).unwrap_or_else(|error| {
            panic!(
                "failed to copy Node runtime from {} to {}: {error}",
                node_binary_path.display(),
                node_output_path.display()
            )
        });
        println!("cargo:rustc-env=MACHDOCH_EMBEDDED_NODE_AVAILABLE=1");
    } else {
        fs::write(&node_output_path, b"").unwrap_or_else(|error| {
            panic!(
                "failed to write bundled Node fallback to {}: {error}",
                node_output_path.display()
            )
        });
        println!("cargo:rustc-env=MACHDOCH_EMBEDDED_NODE_AVAILABLE=0");
    }

    tauri_build::build()
}
