import type { McpEffectiveServerConfig } from "../mcp/types.js";

export const isMcpToolEnabledForProjection = (
  server: McpEffectiveServerConfig,
  toolName: string,
): boolean => {
  if (server.toolOverrides?.[toolName]?.enabled === false) return false;
  const directTools = server.exposure?.directTools;
  const directEnabled =
    typeof directTools === "boolean"
      ? directTools
      : directTools?.enabled !== false;
  if (!directEnabled || server.exposure?.mode === "meta-tools") return false;
  if (typeof directTools !== "object" || directTools === null) return true;
  if (directTools.include && !directTools.include.includes(toolName)) {
    return false;
  }
  return !directTools.exclude?.includes(toolName);
};

export const getMcpToolProjectionPrefix = (
  server: McpEffectiveServerConfig,
): string | undefined => {
  const directTools = server.exposure?.directTools;
  return typeof directTools === "object" && directTools !== null
    ? directTools.namespacePrefix?.trim() || undefined
    : undefined;
};
