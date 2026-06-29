use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::{Map, Value};

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

    fs::write(&file_path, serialized).map_err(|error| {
        format!(
            "Failed to write the desktop conversation context file {}: {error}",
            file_path.display()
        )
    })?;

    Ok(file_path)
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

fn write_workspace_payload_file(
    workspace_root: &str,
    label: &str,
    contents: &str,
) -> Result<PathBuf, String> {
    let unique_id = TEMP_FILE_COUNTER.fetch_add(1, Ordering::SeqCst);
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
    fs::write(&file_path, contents).map_err(|error| {
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

    use serde_json::json;

    use super::{
        build_cli_args, cleanup_temporary_file, cleanup_temporary_files,
        rewrite_ralph_payload_arguments, write_conversation_context_file, CliCommandOptions,
    };

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

        cleanup_temporary_file(Some(&first_path));
        cleanup_temporary_file(Some(&second_path));
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

        cleanup_temporary_files(&payload_paths);
        let _ = fs::remove_dir_all(workspace);
    }
}
