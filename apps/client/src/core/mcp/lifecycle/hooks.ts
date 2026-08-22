import {
  getSourceServerIdFromManagedId,
  isManagedMcpId,
  parseManagedMcpToolName,
} from "./ids.js";
import {
  normalizeMcpLifecycleAgent,
  normalizeMcpLifecycleOperation,
  normalizeMcpLifecyclePhase,
  type McpLifecycleHookOptions,
  type McpUsageEvent,
} from "./schema.js";
import { isRecord, optionalNumber, optionalString } from "./utils.js";

const createBaseHookEvent = (
  payload: Record<string, unknown>,
  options: McpLifecycleHookOptions,
): Pick<
  McpUsageEvent,
  | "timestamp"
  | "workspaceRoot"
  | "agent"
  | "phase"
  | "durationMs"
  | "toolUseId"
  | "turnId"
  | "sessionId"
> => {
  const timestamp = options.timestamp ?? optionalString(payload.timestamp);
  const workspaceRoot =
    options.workspaceRoot ??
    optionalString(payload.workspace_root) ??
    optionalString(payload.workspaceRoot) ??
    optionalString(payload.cwd);
  const durationMs =
    optionalNumber(payload.duration_ms) ?? optionalNumber(payload.durationMs);
  const toolUseId =
    optionalString(payload.tool_use_id) ?? optionalString(payload.toolUseId);
  const turnId =
    optionalString(payload.turn_id) ?? optionalString(payload.turnId);
  const sessionId =
    optionalString(payload.session_id) ?? optionalString(payload.sessionId);

  return {
    ...(timestamp ? { timestamp } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    agent:
      normalizeMcpLifecycleAgent(optionalString(options.agent)) ?? "codex-cli",
    phase: options.phase,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
};

export const createMcpUsageEventFromHookPayload = (
  payload: unknown,
  options: McpLifecycleHookOptions | undefined,
): McpUsageEvent | undefined => {
  const phase = normalizeMcpLifecyclePhase(optionalString(options?.phase));

  if (!isRecord(payload) || !options || !phase) {
    return undefined;
  }

  const baseEvent = createBaseHookEvent(payload, { ...options, phase });
  const toolName =
    optionalString(payload.tool_name) ?? optionalString(payload.toolName);

  if (toolName) {
    const parsedToolName = parseManagedMcpToolName(toolName);

    if (!parsedToolName) {
      return undefined;
    }

    return {
      ...baseEvent,
      serverId: parsedToolName.managedId,
      managedId: parsedToolName.managedId,
      ...(parsedToolName.sourceServerId
        ? { sourceServerId: parsedToolName.sourceServerId }
        : {}),
      operation: "tool",
      target: parsedToolName.remoteName,
    };
  }

  const apiServerId =
    optionalString(payload.server_label) ??
    optionalString(payload.serverLabel) ??
    optionalString(payload.server_name) ??
    optionalString(payload.serverName);

  if (!apiServerId || !isManagedMcpId(apiServerId)) {
    return undefined;
  }

  const sourceServerId = getSourceServerIdFromManagedId(apiServerId);
  const operation =
    normalizeMcpLifecycleOperation(optionalString(payload.operation)) ?? "tool";
  const target =
    optionalString(payload.name) ??
    optionalString(payload.tool_name) ??
    optionalString(payload.toolName);

  return {
    ...baseEvent,
    serverId: apiServerId,
    managedId: apiServerId,
    ...(sourceServerId ? { sourceServerId } : {}),
    operation,
    ...(target ? { target } : {}),
  };
};
