use std::collections::HashMap;

use super::{resolve_agent_cli_binary, ProviderRuntimeModel, ProviderRuntimeModelCapabilities};

pub(super) fn create_claude_cli_runtime_model(model_id: &str) -> ProviderRuntimeModel {
    let long_context = matches!(model_id, "sonnet" | "opus");
    let reasoning_modes = match model_id {
        "haiku" => vec!["default"],
        "sonnet" | "opusplan" => vec!["default", "low", "medium", "high", "max"],
        "best" | "opus" => vec!["default", "low", "medium", "high", "xhigh", "max"],
        _ => vec!["default"],
    }
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();

    ProviderRuntimeModel {
        id: model_id.to_string(),
        label: None,
        stage: Some("stable".to_string()),
        release_date: None,
        recommended_for: vec!["coding".to_string()],
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(false),
            tool_use: Some(true),
            reasoning: Some(reasoning_modes.len() > 1),
            streaming: Some(true),
            context_window_tokens: None,
            long_context_window_tokens: long_context.then_some(1_000_000),
            max_output_tokens: None,
            reasoning_modes: Some(reasoning_modes),
            default_reasoning_mode: None,
            supported_image_media_types: Some(Vec::new()),
            voice: Some(false),
            computer_use: Some(false),
        },
        warnings: Vec::new(),
        source: "provider-docs".to_string(),
    }
}

pub(super) fn fetch_claude_cli_model_catalog(
    env: &HashMap<String, String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let Some(_binary) = resolve_agent_cli_binary("claude-cli", env) else {
        return Err(
            "Claude CLI binary was not found. Configure MACHDOCH_CLAUDE_CLI_PATH or install `claude` on PATH."
                .to_string(),
        );
    };

    Ok(["default", "best", "sonnet", "opus", "haiku", "opusplan"]
        .into_iter()
        .map(create_claude_cli_runtime_model)
        .collect())
}
