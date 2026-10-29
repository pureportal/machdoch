use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::super::normalize_optional_string;
use super::{
    command::{run_agent_cli_command_with_input, AgentCliCommandOutput},
    normalize::json_string,
    resolve_agent_cli_binary, ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
};

const CLAUDE_CLI_EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_CLI_LONG_CONTEXT_SUFFIX: &str = "[1m]";
const CLAUDE_CLI_LONG_CONTEXT_TOKENS: u64 = 1_000_000;
const CLAUDE_CLI_INITIALIZE_REQUEST_ID: &str = "machdoch-model-catalog";
const CLAUDE_CLI_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);
const CLAUDE_CLI_SUBAGENT_PROMPT_FLAG: &str = "--append-subagent-system-prompt-file";

fn json_bool(value: &serde_json::Value, key: &str) -> Option<bool> {
    value.get(key).and_then(serde_json::Value::as_bool)
}

fn claude_cli_reasoning_modes(entry: &serde_json::Value) -> Vec<String> {
    let mut modes = vec!["default".to_string()];

    if json_bool(entry, "supportsEffort") != Some(true) {
        return modes;
    }

    for level in entry
        .get("supportedEffortLevels")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
    {
        let level = level.trim().to_ascii_lowercase();

        if CLAUDE_CLI_EFFORT_LEVELS.contains(&level.as_str()) && !modes.contains(&level) {
            modes.push(level);
        }
    }

    modes
}

fn strip_long_context_suffix(model_id: &str) -> Option<&str> {
    model_id
        .strip_suffix(CLAUDE_CLI_LONG_CONTEXT_SUFFIX)
        .filter(|base| !base.is_empty())
}

fn create_claude_cli_runtime_model(entry: &serde_json::Value) -> Option<ProviderRuntimeModel> {
    if json_bool(entry, "disabled") == Some(true) {
        return None;
    }

    let id = json_string(entry, "value")?.to_ascii_lowercase();
    let label = json_string(entry, "displayName").filter(|label| !label.eq_ignore_ascii_case(&id));
    let family = json_string(entry, "resolvedModel")
        .unwrap_or_else(|| id.clone())
        .to_ascii_lowercase();
    let reasoning_modes = claude_cli_reasoning_modes(entry);
    let mut recommended_for = vec!["coding".to_string()];

    if family.contains("haiku") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    } else if family.contains("sonnet") {
        recommended_for.push("fast".to_string());
    }

    Some(ProviderRuntimeModel {
        id,
        label,
        stage: Some("stable".to_string()),
        release_date: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(false),
            tool_use: Some(true),
            reasoning: Some(reasoning_modes.len() > 1),
            streaming: Some(true),
            context_window_tokens: None,
            long_context_window_tokens: None,
            max_output_tokens: None,
            reasoning_modes: Some(reasoning_modes),
            default_reasoning_mode: None,
            supported_image_media_types: Some(Vec::new()),
            voice: Some(false),
            computer_use: Some(false),
            native_subagents: None,
            native_goal: None,
        },
        warnings: Vec::new(),
        source: "provider-probe".to_string(),
    })
}

/// Parses the `models` list of a Claude CLI `initialize` control response. This is the
/// same list the CLI's own `/model` picker shows for the signed-in account. Rows with the
/// `[1m]` suffix are folded into their base model as its long-context tier, because
/// Machdoch selects the 1M window through the context-size control instead.
pub(super) fn parse_claude_cli_model_catalog(
    models: &serde_json::Value,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let entries = models
        .as_array()
        .ok_or_else(|| "Claude CLI model catalog did not contain a models array.".to_string())?;
    let mut runtime_models = Vec::<ProviderRuntimeModel>::new();
    let mut long_context_models = Vec::<ProviderRuntimeModel>::new();

    for model in entries.iter().filter_map(create_claude_cli_runtime_model) {
        if strip_long_context_suffix(&model.id).is_some() {
            long_context_models.push(model);
        } else if !runtime_models
            .iter()
            .any(|existing| existing.id == model.id)
        {
            runtime_models.push(model);
        }
    }

    for mut long_context_model in long_context_models {
        let base = strip_long_context_suffix(&long_context_model.id).map(str::to_string);

        match runtime_models
            .iter_mut()
            .find(|model| Some(&model.id) == base.as_ref())
        {
            Some(model) => {
                model.capabilities.long_context_window_tokens =
                    Some(CLAUDE_CLI_LONG_CONTEXT_TOKENS);
            }
            // A 1M row without a plain sibling stays selectable as its own model.
            None => {
                long_context_model.capabilities.context_window_tokens =
                    Some(CLAUDE_CLI_LONG_CONTEXT_TOKENS);
                runtime_models.push(long_context_model);
            }
        }
    }

    if runtime_models.is_empty() {
        return Err("Claude CLI did not return any selectable models.".to_string());
    }

    Ok(runtime_models)
}

fn claude_cli_initialize_response(stdout: &str) -> Result<serde_json::Value, String> {
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
    {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if json_string(&message, "type").as_deref() != Some("control_response") {
            continue;
        }
        let Some(response) = message.get("response") else {
            continue;
        };
        if json_string(response, "request_id").as_deref() != Some(CLAUDE_CLI_INITIALIZE_REQUEST_ID)
        {
            continue;
        }
        if json_string(response, "subtype").as_deref() != Some("success") {
            let detail = json_string(response, "error")
                .unwrap_or_else(|| "the CLI rejected the initialize request".to_string());
            return Err(format!("Claude CLI model discovery failed: {detail}"));
        }

        return response
            .get("response")
            .cloned()
            .ok_or_else(|| "Claude CLI initialize response was empty.".to_string());
    }

    Err("Claude CLI did not answer the initialize request.".to_string())
}

/// Parses a Claude CLI `initialize` response into the model catalog and marks each model
/// with the native features the CLI reported: subagents (its agent list, when Machdoch can
/// also pass them its instructions) and the `/goal` command.
pub(super) fn parse_claude_cli_initialize_output(
    stdout: &str,
    subagent_instructions_supported: bool,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let response = claude_cli_initialize_response(stdout)?;
    let models = response
        .get("models")
        .ok_or_else(|| "Claude CLI initialize response did not list models.".to_string())?;
    let has_subagents = response
        .get("agents")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|agents| !agents.is_empty());
    let has_goal_command = response
        .get("commands")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .any(|command| json_string(command, "name").as_deref() == Some("goal"));
    let mut runtime_models = parse_claude_cli_model_catalog(models)?;

    for model in &mut runtime_models {
        model.capabilities.native_subagents =
            Some(has_subagents && subagent_instructions_supported);
        model.capabilities.native_goal = Some(has_goal_command);
    }

    Ok(runtime_models)
}

/// An empty file passed as `--append-subagent-system-prompt-file`, so the probe also
/// confirms the flag Machdoch needs to give native subagents their instructions.
struct EmptyProbeFile(PathBuf);

impl EmptyProbeFile {
    fn create() -> Result<Self, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "machdoch-claude-probe-{}-{nonce}.md",
            std::process::id()
        ));
        fs::write(&path, "")
            .map_err(|error| format!("Failed to prepare the Claude CLI probe: {error}"))?;
        Ok(Self(path))
    }
}

impl Drop for EmptyProbeFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn run_claude_cli_initialize(
    binary: &Path,
    env: &HashMap<String, String>,
    extra_args: &[&str],
) -> Result<AgentCliCommandOutput, String> {
    let request = serde_json::json!({
        "type": "control_request",
        "request_id": CLAUDE_CLI_INITIALIZE_REQUEST_ID,
        "request": { "subtype": "initialize" },
    });
    let mut args = vec![
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--no-session-persistence",
    ];
    args.extend_from_slice(extra_args);

    run_agent_cli_command_with_input(
        binary,
        &args,
        env,
        &format!("{request}\n"),
        CLAUDE_CLI_DISCOVERY_TIMEOUT,
    )
}

pub(super) fn fetch_claude_cli_model_catalog(
    env: &HashMap<String, String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let Some(binary) = resolve_agent_cli_binary("claude-cli", env) else {
        return Err(
            "Claude CLI binary was not found. Configure MACHDOCH_CLAUDE_CLI_PATH or install `claude` on PATH."
                .to_string(),
        );
    };
    let probe_file = EmptyProbeFile::create()?;
    let probe_path = probe_file.0.to_string_lossy().to_string();
    let mut output = run_claude_cli_initialize(
        &binary,
        env,
        &[CLAUDE_CLI_SUBAGENT_PROMPT_FLAG, probe_path.as_str()],
    )?;
    let subagent_instructions_supported = !(output.exit_code != Some(0)
        && format!("{}{}", output.stderr, output.stdout).contains(&format!(
            "unknown option '{CLAUDE_CLI_SUBAGENT_PROMPT_FLAG}'"
        )));

    if !subagent_instructions_supported {
        output = run_claude_cli_initialize(&binary, env, &[])?;
    }

    match parse_claude_cli_initialize_output(&output.stdout, subagent_instructions_supported) {
        Ok(models) => Ok(models),
        Err(error) if output.exit_code == Some(0) => Err(error),
        Err(error) => {
            let detail = normalize_optional_string(Some(output.stderr.as_str()))
                .unwrap_or_else(|| format!("exited with code {:?}", output.exit_code));
            Err(format!("{error} {detail}"))
        }
    }
}
