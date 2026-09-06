import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { LocalToolRuntime } from "./runtime.js";

export const createLocalMcpServer = (runtime: LocalToolRuntime): Server => {
  const server = new Server(
    { name: "machdoch", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: runtime.definitions.map((definition) => ({
      ...definition.spec,
      inputSchema: { ...definition.spec.inputSchema, type: "object" as const },
      annotations: {
        readOnlyHint:
          definition.effect === "read" || definition.effect === "external-read",
        openWorldHint: definition.effect.startsWith("external-"),
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const { toolResult } = await runtime.call(
        request.params.name,
        request.params.arguments ?? {},
        extra.signal,
      );
      return {
        content: toolResult.content?.map((item) =>
          item.type === "image"
            ? {
                type: "image" as const,
                data: item.data,
                mimeType: item.mediaType,
              }
            : item,
        ) ?? [{ type: "text" as const, text: toolResult.output }],
        ...(toolResult.isError === undefined
          ? {}
          : { isError: toolResult.isError }),
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });
  return server;
};
