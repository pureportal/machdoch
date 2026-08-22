use std::collections::HashMap;

use super::{resolve_agent_cli_binary, ProviderRuntimeModel};

pub(super) fn fetch_claude_cli_model_catalog(
    env: &HashMap<String, String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let Some(_binary) = resolve_agent_cli_binary("claude-cli", env) else {
        return Err(
            "Claude CLI binary was not found. Configure MACHDOCH_CLAUDE_CLI_PATH or install `claude` on PATH."
                .to_string(),
        );
    };

    Err("Claude CLI does not expose a non-interactive model-list command.".to_string())
}
