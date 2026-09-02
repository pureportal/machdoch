const SAFE_MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

export interface McpOAuthRecoveryCommands {
  authorize: string;
  start: string;
  finish: string;
}

export interface McpOAuthRecoveryCommandOptions {
  scope?: "user";
  workspaceRoot?: string;
}

export const getMcpOAuthRecoveryCommands = (
  serverId: string,
  options: McpOAuthRecoveryCommandOptions = {},
): McpOAuthRecoveryCommands => {
  const serverArgument = SAFE_MCP_SERVER_ID_PATTERN.test(serverId)
    ? serverId
    : "<server-id>";
  const scopeArguments = options.scope ? ` --scope ${options.scope}` : "";
  const workspaceArguments = options.workspaceRoot
    ? ` --cwd "${options.workspaceRoot}"`
    : "";
  const commandArguments = `${scopeArguments}${workspaceArguments}`;

  return {
    authorize: `machdoch mcp oauth-authorize ${serverArgument}${commandArguments}`,
    start: `machdoch mcp oauth-start ${serverArgument}${commandArguments}`,
    finish: `machdoch mcp oauth-finish ${serverArgument} <callback-url-or-code>${commandArguments}`,
  };
};

export const formatMcpOAuthAuthorizationRequiredMessage = (
  serverId: string,
  options: McpOAuthRecoveryCommandOptions = {},
): string => {
  const commands = getMcpOAuthRecoveryCommands(serverId, options);
  return `MCP OAuth authorization is required for server \`${serverId}\`. Run \`${commands.authorize}\` before reconnecting. If automatic browser callback handling is unavailable, run \`${commands.start}\`, then \`${commands.finish}\`.`;
};

export const formatMcpOAuthAuthorizationFailureMessage = (
  serverId: string,
  reason: string,
  options: McpOAuthRecoveryCommandOptions = {},
): string => {
  const commands = getMcpOAuthRecoveryCommands(serverId, options);
  return `MCP OAuth authorization could not be completed for server \`${serverId}\`: ${reason} Retry \`${commands.authorize}\`. If automatic browser callback handling remains unavailable, run \`${commands.start}\`, then \`${commands.finish}\`.`;
};
