use serde_json::Value;

use crate::runtime_snapshot::resolve_workspace_root_path;

use super::{
    diagnostics::format_command_failure, process::hide_child_process_window,
    InstructionCommandRequest, McpCommandRequest, SchedulerCommandRequest,
};

fn parse_scheduler_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the scheduler CLI JSON response: {error}. Output: {trimmed_stdout}"
        )
    })
}

fn parse_mcp_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!("Failed to parse the MCP CLI JSON response: {error}. Output: {trimmed_stdout}")
    })
}

fn parse_instruction_command_response(stdout: &str) -> Result<Value, String> {
    let trimmed_stdout = stdout.trim();

    serde_json::from_str::<Value>(trimmed_stdout).map_err(|error| {
        format!(
            "Failed to parse the instruction CLI JSON response: {error}. Output: {trimmed_stdout}"
        )
    })
}

pub(super) fn execute_scheduler_command(request: SchedulerCommandRequest) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "scheduler".to_string(),
    ];

    for argument in request.arguments {
        let normalized = argument.trim();

        if !normalized.is_empty() {
            cli_args.push(normalized.to_string());
        }
    }

    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;
    hide_child_process_window(&mut cli_command.command);

    let output = cli_command.command.output().map_err(|error| {
        format!(
            "Failed to launch the scheduler CLI. {} {error}",
            crate::shared_cli::cli_runtime_error_hint()
        )
    })?;
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "The scheduler CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_scheduler_command_response(&stdout_text)
}

pub(super) fn execute_mcp_command(request: McpCommandRequest) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "mcp".to_string(),
    ];

    for argument in request.arguments {
        let normalized = argument.trim();

        if !normalized.is_empty() {
            cli_args.push(normalized.to_string());
        }
    }

    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;
    hide_child_process_window(&mut cli_command.command);

    let output = cli_command.command.output().map_err(|error| {
        format!(
            "Failed to launch the MCP CLI. {} {error}",
            crate::shared_cli::cli_runtime_error_hint()
        )
    })?;
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "The MCP CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_mcp_command_response(&stdout_text)
}

pub(super) fn execute_instruction_command(
    request: InstructionCommandRequest,
) -> Result<Value, String> {
    let workspace_path = resolve_workspace_root_path(&request.workspace_root)?;
    let normalized_workspace_root = workspace_path.display().to_string();
    let mut cli_args = vec![
        "--json".to_string(),
        "--cwd".to_string(),
        normalized_workspace_root,
        "instructions".to_string(),
    ];

    for argument in request.arguments {
        let normalized = argument.trim();

        if !normalized.is_empty() {
            cli_args.push(normalized.to_string());
        }
    }

    let mut cli_command = crate::shared_cli::create_shared_cli_command(&cli_args)?;
    hide_child_process_window(&mut cli_command.command);

    let output = cli_command.command.output().map_err(|error| {
        format!(
            "Failed to launch the instruction CLI. {} {error}",
            crate::shared_cli::cli_runtime_error_hint()
        )
    })?;
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "The instruction CLI command failed. {}",
            format_command_failure(&stderr_text, &stdout_text)
        ));
    }

    parse_instruction_command_response(&stdout_text)
}
