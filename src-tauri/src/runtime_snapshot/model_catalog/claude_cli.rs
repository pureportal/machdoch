use std::{collections::HashMap, time::Duration};

use super::super::normalize_optional_string;
use super::{
    command::run_agent_cli_command,
    normalize::{is_anthropic_runtime_model, runtime_model_stage},
    resolve_agent_cli_binary, ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
};

const CLAUDE_CLI_ALIAS_MODELS: [&str; 7] = [
    "sonnet",
    "opus",
    "haiku",
    "fable",
    "sonnet[1m]",
    "opus[1m]",
    "opusplan",
];

fn is_claude_cli_alias_model(model_id: &str) -> bool {
    CLAUDE_CLI_ALIAS_MODELS
        .iter()
        .any(|alias| *alias == model_id)
}

fn is_claude_cli_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    is_claude_cli_alias_model(&normalized) || is_anthropic_runtime_model(&normalized)
}

fn claude_cli_model_sort_rank(model_id: &str) -> usize {
    CLAUDE_CLI_ALIAS_MODELS
        .iter()
        .position(|alias| *alias == model_id)
        .unwrap_or(CLAUDE_CLI_ALIAS_MODELS.len())
}

fn create_claude_cli_runtime_model(model_id: &str) -> ProviderRuntimeModel {
    let normalized = model_id.to_ascii_lowercase();
    let mut recommended_for = Vec::new();

    if normalized.contains("sonnet")
        || normalized.contains("opus")
        || normalized.contains("fable")
        || normalized.starts_with("claude-")
    {
        recommended_for.push("coding".to_string());
    }

    if normalized.contains("sonnet") || normalized.contains("haiku") {
        recommended_for.push("fast".to_string());
    }

    if normalized.contains("haiku") {
        recommended_for.push("cheap".to_string());
    }

    ProviderRuntimeModel {
        id: normalized.clone(),
        label: None,
        stage: runtime_model_stage(&normalized).or_else(|| Some("stable".to_string())),
        release_date: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(false),
            tool_use: Some(true),
            reasoning: Some(true),
            streaming: Some(true),
            context_window_tokens: None,
            max_output_tokens: None,
            voice: Some(false),
            computer_use: Some(false),
        },
        warnings: Vec::new(),
        source: "provider-probe".to_string(),
    }
}

fn collect_claude_cli_help_model_ids(raw: &str) -> Vec<String> {
    let mut by_id = HashMap::<String, ()>::new();
    let mut token = String::new();
    let flush_token = |token: &mut String, by_id: &mut HashMap<String, ()>| {
        if token.is_empty() {
            return;
        }

        let normalized = token
            .trim_matches(|character: char| {
                !character.is_ascii_alphanumeric()
                    && character != '-'
                    && character != '.'
                    && character != '['
                    && character != ']'
            })
            .to_ascii_lowercase();

        if is_claude_cli_runtime_model(&normalized) {
            by_id.entry(normalized).or_insert(());
        }

        token.clear();
    };

    for character in raw.chars() {
        if character.is_ascii_alphanumeric()
            || character == '-'
            || character == '.'
            || character == '['
            || character == ']'
        {
            token.push(character);
        } else {
            flush_token(&mut token, &mut by_id);
        }
    }

    flush_token(&mut token, &mut by_id);

    let mut ids = by_id.into_keys().collect::<Vec<_>>();
    ids.sort_by(|left, right| {
        claude_cli_model_sort_rank(left)
            .cmp(&claude_cli_model_sort_rank(right))
            .then_with(|| left.cmp(right))
    });

    ids
}

pub(super) fn parse_claude_cli_model_catalog(
    raw: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let ids = collect_claude_cli_help_model_ids(raw);

    if ids.is_empty() {
        return Err("Claude CLI help output did not include any model IDs or aliases.".to_string());
    }

    Ok(ids
        .into_iter()
        .map(|id| create_claude_cli_runtime_model(&id))
        .collect())
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
    let attempts: [(&[&str], &str); 2] =
        [(&["--help"], "claude --help"), (&["help"], "claude help")];
    let mut failures = Vec::new();

    for (args, label) in attempts {
        match run_agent_cli_command(&binary, args, env, Duration::from_secs(8)) {
            Ok(output) if output.exit_code == Some(0) => {
                let combined_output = format!("{}\n{}", output.stdout, output.stderr);

                match parse_claude_cli_model_catalog(&combined_output) {
                    Ok(models) => return Ok(models),
                    Err(error) => failures.push(format!("{label}: {error}")),
                }
            }
            Ok(output) => {
                let detail = normalize_optional_string(Some(output.stderr.as_str()))
                    .or_else(|| normalize_optional_string(Some(output.stdout.as_str())))
                    .unwrap_or_else(|| {
                        format!(
                            "exited with code {}",
                            output
                                .exit_code
                                .map(|code| code.to_string())
                                .unwrap_or_else(|| "unknown".to_string())
                        )
                    });

                failures.push(format!("{label}: {detail}"));
            }
            Err(error) => failures.push(format!("{label}: {error}")),
        }
    }

    Err(format!(
        "Claude CLI model discovery failed. {}",
        failures.join(" ")
    ))
}
