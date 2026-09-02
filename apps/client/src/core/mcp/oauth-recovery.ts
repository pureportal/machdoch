const SAFE_MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

export interface McpOAuthRecoveryCommands {
  authorize: string;
  start: string;
  finish: string;
}

export const getMcpOAuthRecoveryCommands = (
  serverId: string,
): McpOAuthRecoveryCommands => {
  const serverArgument = SAFE_MCP_SERVER_ID_PATTERN.test(serverId)
    ? serverId
    : "<server-id>";

  return {
    authorize: `machdoch mcp oauth-authorize ${serverArgument}`,
    start: `machdoch mcp oauth-start ${serverArgument}`,
    finish: `machdoch mcp oauth-finish ${serverArgument} <callback-url-or-code>`,
  };
};

export const formatMcpOAuthAuthorizationRequiredMessage = (
  serverId: string,
): string => {
  const commands = getMcpOAuthRecoveryCommands(serverId);
  return `MCP OAuth authorization is required for server \`${serverId}\`. Run \`${commands.authorize}\` before reconnecting. If automatic browser callback handling is unavailable, run \`${commands.start}\`, then \`${commands.finish}\`.`;
};

export const formatMcpOAuthAuthorizationFailureMessage = (
  serverId: string,
  reason: string,
): string => {
  const commands = getMcpOAuthRecoveryCommands(serverId);
  return `MCP OAuth authorization could not be completed for server \`${serverId}\`: ${reason} Retry \`${commands.authorize}\`. If automatic browser callback handling remains unavailable, run \`${commands.start}\`, then \`${commands.finish}\`.`;
};
