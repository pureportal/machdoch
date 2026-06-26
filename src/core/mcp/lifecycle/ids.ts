import { normalizeOptionalString } from "../../../helpers/normalize-optional-string.helper.js";
import { MACHDOCH_MANAGED_MCP_PREFIX } from "./schema.js";

export const isManagedMcpId = (value: string): boolean => {
  return value.startsWith(MACHDOCH_MANAGED_MCP_PREFIX);
};

export const createManagedMcpId = (sourceServerId: string): string => {
  const trimmed = normalizeOptionalString(sourceServerId) ?? "server";
  const unprefixed = isManagedMcpId(trimmed)
    ? trimmed.slice(MACHDOCH_MANAGED_MCP_PREFIX.length)
    : trimmed;
  const normalized = unprefixed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 80);

  return `${MACHDOCH_MANAGED_MCP_PREFIX}${normalized || "server"}`;
};

export const getSourceServerIdFromManagedId = (
  managedId: string,
): string | undefined => {
  if (!isManagedMcpId(managedId)) {
    return undefined;
  }

  return normalizeOptionalString(
    managedId.slice(MACHDOCH_MANAGED_MCP_PREFIX.length),
  );
};

export const parseManagedMcpToolName = (
  toolName: string,
):
  | {
      managedId: string;
      sourceServerId?: string;
      remoteName: string;
    }
  | undefined => {
  const parts = toolName.split("__");
  const serverId = parts[1];

  if (parts[0] !== "mcp" || !serverId || parts.length < 3) {
    return undefined;
  }

  if (!isManagedMcpId(serverId)) {
    return undefined;
  }

  const remoteName = parts.slice(2).join("__");

  if (!remoteName) {
    return undefined;
  }

  const sourceServerId = getSourceServerIdFromManagedId(serverId);

  return {
    managedId: serverId,
    ...(sourceServerId ? { sourceServerId } : {}),
    remoteName,
  };
};
