use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EmbeddedRuntimeInputs {
    Complete {
        cli_bundle: PathBuf,
        node_binary: PathBuf,
    },
    Incomplete(RuntimeInputIssue),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RuntimeInputIssue {
    input: RuntimeInput,
    state: RuntimeInputState,
}

#[derive(Debug, PartialEq, Eq)]
enum RuntimeInput {
    CliBundle,
    NodeBinary,
}

#[derive(Debug, PartialEq, Eq)]
enum RuntimeInputState {
    Missing,
    Invalid,
}

impl EmbeddedRuntimeInputs {
    pub(crate) fn classify(cli_bundle: &Path, node_binary: Option<&Path>) -> Self {
        if let Some(state) = classify_file(RuntimeInput::CliBundle, cli_bundle) {
            return Self::Incomplete(RuntimeInputIssue {
                input: RuntimeInput::CliBundle,
                state,
            });
        }

        let Some(node_binary) = node_binary else {
            return Self::Incomplete(RuntimeInputIssue {
                input: RuntimeInput::NodeBinary,
                state: RuntimeInputState::Missing,
            });
        };

        if let Some(state) = classify_file(RuntimeInput::NodeBinary, node_binary) {
            return Self::Incomplete(RuntimeInputIssue {
                input: RuntimeInput::NodeBinary,
                state,
            });
        }

        Self::Complete {
            cli_bundle: cli_bundle.to_path_buf(),
            node_binary: node_binary.to_path_buf(),
        }
    }

    pub(crate) fn rebuild_dependencies(&self) -> Vec<&Path> {
        match self {
            Self::Complete {
                cli_bundle,
                node_binary,
            } => vec![cli_bundle, node_binary],
            Self::Incomplete(_) => Vec::new(),
        }
    }
}

impl RuntimeInputIssue {
    pub(crate) fn build_error(&self, cli_bundle_path: &Path) -> String {
        match (&self.input, &self.state) {
            (RuntimeInput::CliBundle, RuntimeInputState::Missing) => format!(
                "The embedded CLI bundle is required for this distributable build but was not found at {}. Run `pnpm build:cli-bundle` from apps/client before building.",
                cli_bundle_path.display()
            ),
            (RuntimeInput::CliBundle, RuntimeInputState::Invalid) => format!(
                "The embedded CLI bundle is required for this distributable build but is invalid at {}. Rebuild it with `pnpm build:cli-bundle` from apps/client before building.",
                cli_bundle_path.display()
            ),
            (RuntimeInput::NodeBinary, RuntimeInputState::Missing) => {
                "The embedded Node runtime is required for this distributable build but no Node executable was found. Install Node.js or set MACHDOCH_NODE_BINARY to a Node executable before building.".to_string()
            }
            (RuntimeInput::NodeBinary, RuntimeInputState::Invalid) => {
                "The embedded Node runtime is required for this distributable build but the selected Node executable is invalid. Set MACHDOCH_NODE_BINARY to a non-empty Node executable or correct PATH before building.".to_string()
            }
        }
    }
}

fn classify_file(input: RuntimeInput, path: &Path) -> Option<RuntimeInputState> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => fs::read(path)
            .ok()
            .filter(|contents| has_expected_header(&input, contents))
            .map_or(Some(RuntimeInputState::Invalid), |_| None),
        Ok(_) => Some(RuntimeInputState::Invalid),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Some(RuntimeInputState::Missing)
        }
        Err(_) => Some(RuntimeInputState::Invalid),
    }
}

fn has_expected_header(input: &RuntimeInput, contents: &[u8]) -> bool {
    match input {
        RuntimeInput::CliBundle => contents.starts_with(b"#!/usr/bin/env node"),
        RuntimeInput::NodeBinary => has_native_executable_header(contents),
    }
}

#[cfg(target_os = "windows")]
fn has_native_executable_header(contents: &[u8]) -> bool {
    contents.starts_with(b"MZ")
}

#[cfg(target_os = "linux")]
fn has_native_executable_header(contents: &[u8]) -> bool {
    contents.starts_with(b"\x7fELF")
}

#[cfg(target_os = "macos")]
fn has_native_executable_header(contents: &[u8]) -> bool {
    matches!(
        contents.get(..4),
        Some(
            [0xfe, 0xed, 0xfa, 0xce]
                | [0xce, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xcf, 0xfa, 0xed, 0xfe]
                | [0xca, 0xfe, 0xba, 0xbe]
                | [0xbe, 0xba, 0xfe, 0xca]
        )
    )
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn has_native_executable_header(contents: &[u8]) -> bool {
    !contents.is_empty()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use super::EmbeddedRuntimeInputs;

    fn temporary_directory(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "machdoch-embedded-runtime-inputs-{name}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary directory should be created");
        directory
    }

    fn write_cli_bundle(path: &Path) {
        fs::write(path, b"#!/usr/bin/env node\nconsole.log('bundle');\n")
            .expect("CLI bundle should be written");
    }

    fn write_node_binary(path: &Path) {
        #[cfg(target_os = "windows")]
        let contents = b"MZnode binary";
        #[cfg(target_os = "linux")]
        let contents = b"\x7fELFnode binary";
        #[cfg(target_os = "macos")]
        let contents = b"\xcf\xfa\xed\xfenode binary";
        #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        let contents = b"node binary";
        fs::write(path, contents).expect("Node binary should be written");
    }

    #[test]
    fn classifies_complete_runtime_inputs() {
        let directory = temporary_directory("complete");
        let cli_bundle = directory.join("machdoch-cli.cjs");
        let node_binary = directory.join("node.exe");
        write_cli_bundle(&cli_bundle);
        write_node_binary(&node_binary);

        assert_eq!(
            EmbeddedRuntimeInputs::classify(&cli_bundle, Some(&node_binary)),
            EmbeddedRuntimeInputs::Complete {
                cli_bundle,
                node_binary,
            }
        );

        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }

    #[test]
    fn missing_cli_bundle_has_an_actionable_error() {
        let directory = temporary_directory("missing-cli");
        let cli_bundle = directory.join("machdoch-cli.cjs");
        let node_binary = directory.join("node.exe");
        write_node_binary(&node_binary);

        let EmbeddedRuntimeInputs::Incomplete(issue) =
            EmbeddedRuntimeInputs::classify(&cli_bundle, Some(&node_binary))
        else {
            panic!("missing CLI bundle should be incomplete");
        };

        assert!(issue.build_error(&cli_bundle).contains("CLI bundle"));
        assert!(issue
            .build_error(&cli_bundle)
            .contains("pnpm build:cli-bundle"));

        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }

    #[test]
    fn missing_node_binary_has_an_actionable_error() {
        let directory = temporary_directory("missing-node");
        let cli_bundle = directory.join("machdoch-cli.cjs");
        write_cli_bundle(&cli_bundle);

        let EmbeddedRuntimeInputs::Incomplete(issue) =
            EmbeddedRuntimeInputs::classify(&cli_bundle, None)
        else {
            panic!("missing Node binary should be incomplete");
        };

        assert!(issue.build_error(&cli_bundle).contains("Node runtime"));
        assert!(issue
            .build_error(&cli_bundle)
            .contains("MACHDOCH_NODE_BINARY"));

        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }

    #[test]
    fn empty_runtime_input_is_invalid() {
        let directory = temporary_directory("invalid");
        let cli_bundle = directory.join("machdoch-cli.cjs");
        let node_binary = directory.join("node.exe");
        write_cli_bundle(&cli_bundle);
        fs::write(&node_binary, []).expect("empty input should be written");

        let EmbeddedRuntimeInputs::Incomplete(issue) =
            EmbeddedRuntimeInputs::classify(&cli_bundle, Some(&node_binary))
        else {
            panic!("empty Node binary should be incomplete");
        };

        assert!(issue.build_error(&cli_bundle).contains("invalid"));

        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }

    #[test]
    fn rejects_nonempty_malformed_runtime_inputs() {
        let directory = temporary_directory("malformed");
        let cli_bundle = directory.join("machdoch-cli.cjs");
        let node_binary = directory.join("node.exe");
        fs::write(&cli_bundle, b"not a Node bundle").expect("malformed CLI should be written");
        write_node_binary(&node_binary);

        assert!(matches!(
            EmbeddedRuntimeInputs::classify(&cli_bundle, Some(&node_binary)),
            EmbeddedRuntimeInputs::Incomplete(_)
        ));

        write_cli_bundle(&cli_bundle);
        fs::write(&node_binary, b"not an executable").expect("malformed Node should be written");

        assert!(matches!(
            EmbeddedRuntimeInputs::classify(&cli_bundle, Some(&node_binary)),
            EmbeddedRuntimeInputs::Incomplete(_)
        ));

        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }

    #[test]
    fn complete_inputs_are_cargo_rebuild_dependencies() {
        let directory = temporary_directory("dependencies");
        let cli_bundle = directory.join("machdoch-cli.cjs");
        let node_binary = directory.join("node.exe");
        write_cli_bundle(&cli_bundle);
        write_node_binary(&node_binary);

        let inputs = EmbeddedRuntimeInputs::classify(&cli_bundle, Some(&node_binary));
        assert_eq!(
            inputs.rebuild_dependencies(),
            vec![cli_bundle.as_path(), node_binary.as_path()]
        );

        fs::remove_dir_all(directory).expect("temporary directory should be removed");
    }
}
