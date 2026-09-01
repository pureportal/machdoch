import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { queryWorkspaceAgentPresence } from "../../_helpers/workspace-agent-presence.js";

const TOOL_NAME = "get_active_workspace_agents";

export const createWorkspacePresenceMcpServer = (
  workspaceRoot: string,
): Server => {
  const server = new Server(
    { name: "machdoch-workspace-presence", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Read advisory presence for other Machdoch agents active in this workspace.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (
      request.params.name !== TOOL_NAME ||
      Object.keys(request.params.arguments ?? {}).length > 0
    ) {
      throw new Error(`Invalid ${TOOL_NAME} request.`);
    }
    const snapshot = await queryWorkspaceAgentPresence(workspaceRoot);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(snapshot, null, 2),
        },
      ],
      structuredContent: snapshot,
    };
  });

  return server;
};

export const runWorkspacePresenceMcpServer = async (
  workspaceRoot: string,
): Promise<void> => {
  const server = createWorkspacePresenceMcpServer(workspaceRoot);

  const close = (): void => {
    void server.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await server.connect(new StdioServerTransport());
};
