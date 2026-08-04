use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime},
};

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    runtime_snapshot::get_user_config_directory,
};

use super::{payload::cleanup_temporary_files, progress::create_progress_timestamp};

static WORKSPACE_PAYLOAD_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
const STALE_INSTRUCTION_PAYLOAD_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const INSTRUCTION_PAYLOAD_DIRECTORY_NAME: &str = ".instruction-command-payloads";
const INSTRUCTION_PAYLOAD_FILE_PREFIX: &str = ".machdoch-instruction-payload-";
// Allow a BOM and the worst-case CRLF-to-LF normalization overhead. The
// shared CLI applies the canonical 128 KiB limit after normalization.
const MAX_INSTRUCTION_PAYLOAD_BYTES: usize = 128 * 1024 * 2 + 3;

fn cleanup_instruction_payload_directory(directory: &Path, max_age: Duration, now: SystemTime) {
    let Ok(directory_metadata) = fs::symlink_metadata(directory) else {
        return;
    };
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with(INSTRUCTION_PAYLOAD_FILE_PREFIX) || !name.ends_with(".tmp") {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let is_stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= max_age);
        if is_stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

pub(super) fn cleanup_stale_instruction_payload_files() {
    let Ok(config_directory) = get_user_config_directory() else {
        return;
    };
    cleanup_instruction_payload_directory(
        &config_directory.join(INSTRUCTION_PAYLOAD_DIRECTORY_NAME),
        STALE_INSTRUCTION_PAYLOAD_MAX_AGE,
        SystemTime::now(),
    );
}

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

fn write_instruction_payload_file(contents: &str) -> Result<PathBuf, String> {
    let unique_id = WORKSPACE_PAYLOAD_FILE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let directory = get_user_config_directory()?.join(INSTRUCTION_PAYLOAD_DIRECTORY_NAME);
    cleanup_instruction_payload_directory(
        &directory,
        STALE_INSTRUCTION_PAYLOAD_MAX_AGE,
        SystemTime::now(),
    );
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(
                "The instruction payload directory is linked or is not a directory.".to_string(),
            )
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&directory).map_err(|error| {
                format!(
                    "Failed to prepare the instruction payload directory {}: {error}",
                    directory.display()
                )
            })?;
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect the instruction payload directory {}: {error}",
                directory.display()
            ))
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!(
                "Failed to secure the instruction payload directory {}: {error}",
                directory.display()
            )
        })?;
    }
    let file_path = directory.join(format!(
        "{INSTRUCTION_PAYLOAD_FILE_PREFIX}{}-{}-{}.tmp",
        std::process::id(),
        create_progress_timestamp(),
        unique_id
    ));
    write_file_atomic(
        &file_path,
        contents.as_bytes(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| {
        format!(
            "Failed to write the instruction payload file {}: {error}",
            file_path.display()
        )
    })?;
    Ok(file_path)
}

pub(super) fn rewrite_instruction_payload_arguments(
    arguments: Vec<String>,
) -> Result<(Vec<String>, Vec<PathBuf>), String> {
    let mut rewritten = Vec::new();
    let mut payload_paths = Vec::new();
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        if argument == "--prompt" {
            let Some(value) = arguments.get(index + 1) else {
                cleanup_temporary_files(&payload_paths);
                return Err("Expected --prompt to include a value.".to_string());
            };
            if value.len() > MAX_INSTRUCTION_PAYLOAD_BYTES {
                cleanup_temporary_files(&payload_paths);
                return Err(format!(
                    "Instruction content exceeds the {MAX_INSTRUCTION_PAYLOAD_BYTES}-byte desktop payload limit."
                ));
            }
            let path = match write_instruction_payload_file(value) {
                Ok(path) => path,
                Err(error) => {
                    cleanup_temporary_files(&payload_paths);
                    return Err(error);
                }
            };
            rewritten.push("--prompt-file".to_string());
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
    use std::{
        fs,
        time::{Duration, SystemTime},
    };

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::{
        cleanup_instruction_payload_directory, rewrite_instruction_payload_arguments,
        rewrite_ralph_payload_arguments, rewrite_task_interview_payload_arguments,
    };
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

    #[test]
    fn instruction_payload_rewrite_moves_markdown_out_of_process_arguments() {
        let (arguments, payload_paths) = rewrite_instruction_payload_arguments(vec![
            "profiles".to_string(),
            "create".to_string(),
            "--prompt".to_string(),
            "# Private profile\n".to_string(),
        ])
        .expect("instruction payload arguments should rewrite");

        assert!(arguments.contains(&"--prompt-file".to_string()));
        assert!(!arguments.contains(&"# Private profile\n".to_string()));
        assert_eq!(payload_paths.len(), 1);
        assert_eq!(
            fs::read_to_string(&payload_paths[0]).expect("instruction payload should be readable"),
            "# Private profile\n"
        );
        #[cfg(unix)]
        assert_private_file_mode(&payload_paths[0]);
        cleanup_temporary_files(&payload_paths);
    }

    #[test]
    fn instruction_payload_rewrite_rejects_oversized_content_before_writing() {
        let error = rewrite_instruction_payload_arguments(vec![
            "profiles".to_string(),
            "create".to_string(),
            "--prompt".to_string(),
            "x".repeat(super::MAX_INSTRUCTION_PAYLOAD_BYTES + 1),
        ])
        .expect_err("oversized instruction payload should fail");

        assert!(error.contains("desktop payload limit"));
    }

    #[test]
    fn instruction_payload_rewrite_allows_bounded_crlf_normalization() {
        let contents = format!("{}Policy", "\r\n".repeat(70_000));
        assert!(contents.len() > 128 * 1024 + 3);
        let (arguments, payload_paths) = rewrite_instruction_payload_arguments(vec![
            "profiles".to_string(),
            "create".to_string(),
            "--prompt".to_string(),
            contents.clone(),
        ])
        .expect("normalizable instruction payload should rewrite");

        assert!(arguments.contains(&"--prompt-file".to_string()));
        assert_eq!(
            fs::read_to_string(&payload_paths[0]).expect("payload should be readable"),
            contents
        );
        cleanup_temporary_files(&payload_paths);
    }

    #[test]
    fn stale_instruction_payload_cleanup_is_bounded_to_owned_regular_files() {
        let directory = std::env::temp_dir().join(format!(
            "machdoch-instruction-payload-cleanup-{}-{}",
            std::process::id(),
            super::WORKSPACE_PAYLOAD_FILE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        fs::create_dir_all(&directory).expect("cleanup fixture directory should be created");
        let owned = directory.join(".machdoch-instruction-payload-1-2-3.tmp");
        let unrelated = directory.join("keep.tmp");
        fs::write(&owned, "private instructions").expect("owned payload should be written");
        fs::write(&unrelated, "unrelated").expect("unrelated file should be written");

        cleanup_instruction_payload_directory(
            &directory,
            Duration::ZERO,
            SystemTime::now() + Duration::from_secs(1),
        );

        assert!(!owned.exists());
        assert!(unrelated.exists());
        let _ = fs::remove_dir_all(directory);
    }
}
