use std::{collections::HashMap, time::Duration};

use super::super::normalize_optional_string;
use super::{
    command::run_agent_cli_command, resolve_agent_cli_binary, ProviderRuntimeModel,
    ProviderRuntimeModelCapabilities,
};

fn is_copilot_cli_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if normalized == "auto" {
        return true;
    }

    normalized.starts_with("gpt-")
        || normalized.starts_with("claude-")
        || normalized.starts_with("gemini-")
}

fn create_copilot_cli_runtime_model(model_id: &str) -> ProviderRuntimeModel {
    let normalized = model_id.to_ascii_lowercase();
    let mut recommended_for = vec!["coding".to_string()];

    if normalized.contains("haiku") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    } else if normalized.contains("sonnet") || normalized.contains("gpt-5.2") {
        recommended_for.push("fast".to_string());
    }

    ProviderRuntimeModel {
        id: normalized,
        label: None,
        stage: Some("stable".to_string()),
        release_date: None,
        description: Some(
            "Model option reported by the local GitHub Copilot CLI help output.".to_string(),
        ),
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
        warnings: vec![
            "Model availability depends on GitHub Copilot plan and organization policy."
                .to_string(),
        ],
        source: "provider-probe".to_string(),
    }
}

fn collect_copilot_cli_help_model_ids(raw: &str) -> Vec<String> {
    let mut by_id = HashMap::<String, ()>::new();
    let mut token = String::new();
    let flush_token = |token: &mut String, by_id: &mut HashMap<String, ()>| {
        if token.is_empty() {
            return;
        }

        let normalized = token
            .trim_matches(|character: char| !character.is_ascii_alphanumeric())
            .to_ascii_lowercase();

        if is_copilot_cli_runtime_model(&normalized) {
            by_id.entry(normalized).or_insert(());
        }

        token.clear();
    };

    for character in raw.chars() {
        if character.is_ascii_alphanumeric() || character == '-' || character == '.' {
            token.push(character);
        } else {
            flush_token(&mut token, &mut by_id);
        }
    }

    flush_token(&mut token, &mut by_id);

    let mut ids = by_id.into_keys().collect::<Vec<_>>();
    ids.sort_by(|left, right| {
        let left_rank = if left == "auto" { 0 } else { 1 };
        let right_rank = if right == "auto" { 0 } else { 1 };

        left_rank.cmp(&right_rank).then_with(|| left.cmp(right))
    });

    ids
}

pub(super) fn parse_copilot_cli_model_catalog(
    raw: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let ids = collect_copilot_cli_help_model_ids(raw);

    if ids.is_empty() {
        return Err("Copilot CLI help output did not include any model IDs.".to_string());
    }

    Ok(ids
        .into_iter()
        .map(|id| create_copilot_cli_runtime_model(&id))
        .collect())
}

pub(super) fn fetch_copilot_cli_model_catalog(
    env: &HashMap<String, String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let Some(binary) = resolve_agent_cli_binary("copilot-cli", env) else {
        return Err(
            "Copilot CLI binary was not found. Configure MACHDOCH_COPILOT_CLI_PATH or install `copilot` on PATH."
                .to_string(),
        );
    };
    let attempts: [(&[&str], &str); 2] =
        [(&["help"], "copilot help"), (&["--help"], "copilot --help")];
    let mut failures = Vec::new();

    for (args, label) in attempts {
        match run_agent_cli_command(&binary, args, env, Duration::from_secs(8)) {
            Ok(output) if output.exit_code == Some(0) => {
                let combined_output = format!("{}\n{}", output.stdout, output.stderr);

                match parse_copilot_cli_model_catalog(&combined_output) {
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
        "Copilot CLI model discovery failed. {}",
        failures.join(" ")
    ))
}
