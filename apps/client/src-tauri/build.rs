use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

mod embedded_runtime_inputs;

use embedded_runtime_inputs::EmbeddedRuntimeInputs;

fn find_node_binary() -> Option<PathBuf> {
    if let Some(path) = env::var_os("MACHDOCH_NODE_BINARY").map(PathBuf::from) {
        return Some(path);
    }

    let binary_name = if cfg!(windows) { "node.exe" } else { "node" };
    let path = env::var_os("PATH")?;

    env::split_paths(&path)
        .map(|entry| entry.join(binary_name))
        .find(|candidate| candidate.is_file())
}

fn main() {
    configure_windows_common_controls_manifest();

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
    println!("cargo:rustc-check-cfg=cfg(machdoch_embedded_runtime)");

    let runtime_inputs =
        EmbeddedRuntimeInputs::classify(&cli_bundle_path, find_node_binary().as_deref());
    for dependency in runtime_inputs.rebuild_dependencies() {
        println!("cargo:rerun-if-changed={}", dependency.display());
    }

    match runtime_inputs {
        EmbeddedRuntimeInputs::Complete {
            cli_bundle,
            node_binary,
        } => {
            if let Err(error) = validate_runtime(&node_binary, &cli_bundle) {
                if is_distributable_build() {
                    panic!("{error}");
                }
                return tauri_build::build();
            }

            copy_file_or_panic(&cli_bundle, &output_path, "bundled CLI");
            copy_file_or_panic(&node_binary, &node_output_path, "Node runtime");
            println!("cargo:rustc-cfg=machdoch_embedded_runtime");
        }
        EmbeddedRuntimeInputs::Incomplete(issue) if is_distributable_build() => {
            panic!("{}", issue.build_error(&cli_bundle_path));
        }
        EmbeddedRuntimeInputs::Incomplete(_) => {}
    }

    tauri_build::build()
}

fn is_distributable_build() -> bool {
    env::var("PROFILE").is_ok_and(|profile| profile != "debug")
}

fn configure_windows_common_controls_manifest() {
    if !cfg!(windows) {
        return;
    }

    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
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

fn validate_runtime(node_binary: &Path, cli_bundle: &Path) -> Result<(), String> {
    run_node_check(node_binary, "--version", None).map_err(|error| {
        format!(
            "The embedded Node runtime is required for this distributable build but the selected executable at {} is invalid: {error}",
            node_binary.display()
        )
    })?;
    run_node_check(node_binary, "--check", Some(cli_bundle)).map_err(|error| {
        format!(
            "The embedded CLI bundle is required for this distributable build but is invalid at {}: {error}",
            cli_bundle.display()
        )
    })
}

fn run_node_check(node_binary: &Path, argument: &str, input: Option<&Path>) -> Result<(), String> {
    let mut command = Command::new(node_binary);
    command.arg(argument);
    if let Some(input) = input {
        command.arg(input);
    }

    let status = command
        .status()
        .map_err(|error| format!("could not start it: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("it exited with {status}"))
    }
}
