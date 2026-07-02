use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};

use super::{payload::cleanup_temporary_files, progress::create_progress_timestamp};

static WORKSPACE_PAYLOAD_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn write_workspace_payload_file(
    workspace_root: &str,
    label: &str,
    contents: &str,
) -> Result<PathBuf, String> {
    let unique_id = WORKSPACE_PAYLOAD_FILE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let directory = Path::new(workspace_root)
        .join(".machdoch")
        .join("ralph")
        .join("payloads");
    let file_path = directory.join(format!(
        ".machdoch-ralph-{label}-{}-{}-{}.tmp",
        std::process::id(),
        create_progress_timestamp(),
        unique_id
    ));

    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Failed to prepare the Ralph payload directory {}: {error}",
            directory.display()
        )
    })?;
    write_file_atomic(
        &file_path,
        contents.as_bytes(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| {
        format!(
            "Failed to write the Ralph payload file {}: {error}",
            file_path.display()
        )
    })?;

    Ok(file_path)
}

pub(super) fn rewrite_ralph_payload_arguments(
    workspace_root: &str,
    arguments: Vec<String>,
) -> Result<(Vec<String>, Vec<PathBuf>), String> {
    let mut rewritten = Vec::new();
    let mut payload_paths = Vec::new();
    let mut params = Vec::new();
    let mut index = 0;

    while index < arguments.len() {
        let argument = &arguments[index];
        let replacement_flag = match argument.as_str() {
            "--prompt" => Some(("--prompt-file", "prompt")),
            "--flow-json" => Some(("--flow-json-file", "flow-json")),
            "--existing-flow-json" => Some(("--existing-flow-json-file", "existing-flow-json")),
            "--input-json" => Some(("--input-json-file", "input-json")),
            _ => None,
        };

        if let Some((flag, label)) = replacement_flag {
            let Some(value) = arguments.get(index + 1) else {
                cleanup_temporary_files(&payload_paths);
                return Err(format!("Expected {argument} to include a value."));
            };
            let path = match write_workspace_payload_file(workspace_root, label, value) {
                Ok(path) => path,
                Err(error) => {
                    cleanup_temporary_files(&payload_paths);
                    return Err(error);
                }
            };
            rewritten.push(flag.to_string());
            rewritten.push(path.display().to_string());
            payload_paths.push(path);
            index += 2;
            continue;
        }

        if argument == "--param" {
            let Some(value) = arguments.get(index + 1) else {
                cleanup_temporary_files(&payload_paths);
                return Err("Expected --param to include a value.".to_string());
            };
            params.push(value.clone());
            index += 2;
            continue;
        }

        rewritten.push(argument.clone());
        index += 1;
    }

    if !params.is_empty() {
        let serialized = serde_json::to_string(&params)
            .map_err(|error| format!("Failed to serialize Ralph params: {error}"))?;
        let path = match write_workspace_payload_file(workspace_root, "params", &serialized) {
            Ok(path) => path,
            Err(error) => {
                cleanup_temporary_files(&payload_paths);
                return Err(error);
            }
        };
        rewritten.push("--params-file".to_string());
        rewritten.push(path.display().to_string());
        payload_paths.push(path);
    }

    Ok((rewritten, payload_paths))
}

pub(super) fn rewrite_task_interview_payload_arguments(
    workspace_root: &str,
    arguments: Vec<String>,
) -> Result<(Vec<String>, Vec<PathBuf>), String> {
    let mut rewritten = Vec::new();
    let mut payload_paths = Vec::new();
    let mut index = 0;

    while index < arguments.len() {
        let argument = &arguments[index];
        let replacement_flag = match argument.as_str() {
            "--prompt" => Some(("--prompt-file", "task-interview-prompt")),
            "--input-json" => Some(("--input-json-file", "task-interview-input-json")),
            _ => None,
        };

        if let Some((flag, label)) = replacement_flag {
            let Some(value) = arguments.get(index + 1) else {
                cleanup_temporary_files(&payload_paths);
                return Err(format!("Expected {argument} to include a value."));
            };
            let path = match write_workspace_payload_file(workspace_root, label, value) {
                Ok(path) => path,
                Err(error) => {
                    cleanup_temporary_files(&payload_paths);
                    return Err(error);
                }
            };
            rewritten.push(flag.to_string());
            rewritten.push(path.display().to_string());
            payload_paths.push(path);
            index += 2;
            continue;
        }

        rewritten.push(argument.clone());
        index += 1;
    }

    Ok((rewritten, payload_paths))
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::{rewrite_ralph_payload_arguments, rewrite_task_interview_payload_arguments};
    use crate::desktop_task::payload::cleanup_temporary_files;

    #[cfg(unix)]
    fn assert_private_file_mode(path: &std::path::Path) {
        let mode = fs::metadata(path)
            .expect("payload metadata should be readable")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(mode, 0o600);
    }

    #[test]
    fn ralph_payload_rewrite_moves_inline_payloads_to_files() {
        let workspace = std::env::temp_dir().join(format!(
            "machdoch-ralph-payload-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&workspace).expect("workspace should be created");

        let (arguments, payload_paths) = rewrite_ralph_payload_arguments(
            workspace.to_string_lossy().as_ref(),
            vec![
                "run".to_string(),
                "--prompt".to_string(),
                "hello".to_string(),
                "--param".to_string(),
                "a=1".to_string(),
                "--param".to_string(),
                "b=2".to_string(),
            ],
        )
        .expect("payload arguments should rewrite");

        assert!(arguments.contains(&"--prompt-file".to_string()));
        assert!(arguments.contains(&"--params-file".to_string()));
        assert_eq!(payload_paths.len(), 2);
        assert_eq!(
            fs::read_to_string(&payload_paths[0]).expect("prompt payload should be readable"),
            "hello"
        );
        assert_eq!(
            fs::read_to_string(&payload_paths[1]).expect("params payload should be readable"),
            r#"["a=1","b=2"]"#
        );

        #[cfg(unix)]
        for payload_path in &payload_paths {
            assert_private_file_mode(payload_path);
        }

        cleanup_temporary_files(&payload_paths);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn task_interview_payload_rewrite_moves_inline_payloads_to_private_files() {
        let workspace = std::env::temp_dir().join(format!(
            "machdoch-task-interview-payload-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&workspace).expect("workspace should be created");

        let (arguments, payload_paths) = rewrite_task_interview_payload_arguments(
            workspace.to_string_lossy().as_ref(),
            vec![
                "--prompt".to_string(),
                "collect requirements".to_string(),
                "--input-json".to_string(),
                r#"{"ticket":"ABC-123"}"#.to_string(),
            ],
        )
        .expect("task interview payload arguments should rewrite");

        assert!(arguments.contains(&"--prompt-file".to_string()));
        assert!(arguments.contains(&"--input-json-file".to_string()));
        assert_eq!(payload_paths.len(), 2);
        assert_eq!(
            fs::read_to_string(&payload_paths[0]).expect("prompt payload should be readable"),
            "collect requirements"
        );
        assert_eq!(
            fs::read_to_string(&payload_paths[1]).expect("input payload should be readable"),
            r#"{"ticket":"ABC-123"}"#
        );

        #[cfg(unix)]
        for payload_path in &payload_paths {
            assert_private_file_mode(payload_path);
        }

        cleanup_temporary_files(&payload_paths);
        let _ = fs::remove_dir_all(workspace);
    }
}
