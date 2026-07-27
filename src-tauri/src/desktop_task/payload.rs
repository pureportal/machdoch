use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const STALE_CONTEXT_FILE_MAX_AGE: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);
const ISOLATED_CODEX_HOME_PREFIX: &str = "machdoch-codex-home-";

use serde_json::{Map, Value};

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};

use super::progress::create_progress_timestamp;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(super) struct CliCommandOptions<'a> {
    pub(super) workspace_root: &'a str,
    pub(super) task: &'a str,
    pub(super) mode: Option<&'a str>,
    pub(super) provider: Option<&'a str>,
    pub(super) model: Option<&'a str>,
    pub(super) reasoning: Option<&'a str>,
    pub(super) conversation_context_file: Option<&'a Path>,
    pub(super) image_paths: &'a [String],
}

pub(super) fn build_cli_args(options: CliCommandOptions<'_>) -> Vec<String> {
    let mut args = vec![
        "--quick".to_string(),
        "--json".to_string(),
        "--verbose".to_string(),
        "--cwd".to_string(),
        options.workspace_root.to_string(),
        "--task".to_string(),
        options.task.to_string(),
    ];

    if let Some(mode) = options.mode {
        args.push("--mode".to_string());
        args.push(mode.to_string());
    }

    if let Some(provider) = options.provider {
        args.push("--runtime-provider".to_string());
        args.push(provider.to_string());
    }

    if let Some(model) = options.model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    if let Some(reasoning) = options.reasoning {
        args.push("--reasoning".to_string());
        args.push(reasoning.to_string());
    }

    if let Some(conversation_context_file) = options.conversation_context_file {
        args.push("--conversation-context-file".to_string());
        args.push(conversation_context_file.display().to_string());
    }

    for image_path in options.image_paths {
        args.push("--image".to_string());
        args.push(image_path.to_string());
    }

    args
}

pub(super) fn write_conversation_context_file(
    conversation_context: &Value,
) -> Result<PathBuf, String> {
    let unique_id = TEMP_FILE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let file_path = std::env::temp_dir().join(format!(
        "machdoch-desktop-context-{}-{}-{}.json",
        std::process::id(),
        create_progress_timestamp(),
        unique_id
    ));
    let serialized = serde_json::to_string(conversation_context)
        .map_err(|error| format!("Failed to serialize conversation context: {error}"))?;

    write_file_atomic(
        &file_path,
        serialized.as_bytes(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| {
        format!(
            "Failed to write the desktop conversation context file {}: {error}",
            file_path.display()
        )
    })?;

    Ok(file_path)
}

pub(super) fn cleanup_stale_conversation_context_files() {
    let temporary_directory = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&temporary_directory) else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };

        let is_stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age >= STALE_CONTEXT_FILE_MAX_AGE);

        if !is_stale {
            continue;
        }

        if file_name.starts_with("machdoch-desktop-context-") && file_name.ends_with(".json") {
            let _ = std::fs::remove_file(entry.path());
        } else if file_name.starts_with(ISOLATED_CODEX_HOME_PREFIX)
            && entry.file_type().is_ok_and(|file_type| file_type.is_dir())
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

pub(super) fn cleanup_temporary_file(path: Option<&PathBuf>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

pub(super) fn cleanup_temporary_files(paths: &[PathBuf]) {
    for path in paths {
        cleanup_temporary_file(Some(path));
    }
}

pub(super) fn enrich_ui_control_conversation_context(
    conversation_context: Option<Value>,
) -> Result<Option<Value>, String> {
    let Some(mut conversation_context) = conversation_context else {
        return Ok(None);
    };

    let Value::Object(context_object) = &mut conversation_context else {
        return Err("Expected the desktop conversation context to be a JSON object.".to_string());
    };

    if context_object
        .get("uiControlEnabled")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok(Some(conversation_context));
    }

    let runtime_info = serde_json::to_value(crate::ui_control::create_ui_control_runtime_info())
        .map_err(|error| format!("Failed to serialize desktop UI control metadata: {error}"))?;

    let ui_control_value = match context_object.get_mut("uiControl") {
        Some(Value::Object(existing)) => {
            let mut merged = match runtime_info {
                Value::Object(object) => object,
                _ => Map::new(),
            };

            for (key, value) in existing.clone() {
                if key != "bridgeCommand" {
                    merged.insert(key, value);
                }
            }

            Value::Object(merged)
        }
        _ => runtime_info,
    };

    context_object.insert("uiControl".to_string(), ui_control_value);

    Ok(Some(conversation_context))
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;

    use super::{
        build_cli_args, cleanup_temporary_file, write_conversation_context_file, CliCommandOptions,
    };

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
    fn desktop_cli_args_force_one_shot_json_execution() {
        let args = build_cli_args(CliCommandOptions {
            workspace_root: "C:/workspace",
            task: "How is the weather?",
            mode: Some("ask"),
            provider: Some("openai"),
            model: Some("gpt-5.2"),
            reasoning: Some("high"),
            conversation_context_file: None,
            image_paths: &[],
        });

        assert_eq!(args[0], "--quick");
        assert!(args.contains(&"--json".to_string()));
        assert!(args.contains(&"--task".to_string()));
        assert!(args.contains(&"How is the weather?".to_string()));
        assert!(args.contains(&"--reasoning".to_string()));
        assert!(args.contains(&"high".to_string()));
    }

    #[test]
    fn desktop_cli_args_forward_image_paths() {
        let image_paths = vec![
            "C:/workspace/screenshot.png".to_string(),
            "C:/workspace/mockup.webp".to_string(),
        ];
        let args = build_cli_args(CliCommandOptions {
            workspace_root: "C:/workspace",
            task: "Describe the images",
            mode: None,
            provider: Some("openai"),
            model: Some("gpt-5.5"),
            reasoning: None,
            conversation_context_file: None,
            image_paths: &image_paths,
        });

        assert_eq!(
            args.windows(2)
                .filter(|pair| pair[0] == "--image")
                .map(|pair| pair[1].clone())
                .collect::<Vec<_>>(),
            image_paths,
        );
    }

    #[test]
    fn desktop_context_temp_files_are_unique_for_parallel_tasks() {
        let context = json!({ "history": [] });
        let first_path = write_conversation_context_file(&context)
            .expect("first context file should be created");
        let second_path = write_conversation_context_file(&context)
            .expect("second context file should be created");

        assert_ne!(first_path, second_path);
        assert_eq!(
            fs::read_to_string(&first_path).expect("first context should be readable"),
            r#"{"history":[]}"#
        );

        #[cfg(unix)]
        {
            assert_private_file_mode(&first_path);
            assert_private_file_mode(&second_path);
        }

        cleanup_temporary_file(Some(&first_path));
        cleanup_temporary_file(Some(&second_path));
    }
}
