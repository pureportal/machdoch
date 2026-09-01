import type { AgentToolDefinition } from "./agent-tools-shared.js";
import { queryWorkspaceAgentPresence } from "./workspace-agent-presence.js";

export const createWorkspaceAgentPresenceToolDefinition =
  (): AgentToolDefinition => ({
    spec: {
      name: "get_active_workspace_agents",
      description:
        "Read advisory presence for other Machdoch agents active in this workspace.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    backingTool: "run",
    riskLevel: "low",
    effect: "read",
    execute: async (_args, context) => {
      const snapshot = await queryWorkspaceAgentPresence(
        context.workspaceRoot,
        context.signal,
      );
      return {
        toolResult: {
          callId: "",
          name: "get_active_workspace_agents",
          output: JSON.stringify(snapshot, null, 2),
        },
        sections: [],
        traceLines: [
          snapshot.status === "available"
            ? `get_active_workspace_agents -> ${snapshot.agents.length}`
            : "get_active_workspace_agents -> unknown",
        ],
      };
    },
  });
