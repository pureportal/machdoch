import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MACHDOCH_STATE_GUIDANCE } from "../_helpers/machdoch-state-tool-definitions.js";
import { MACHDOCH_AGENT_SESSION_GUIDANCE } from "../_helpers/machdoch-session-tool-definitions.js";
import { createLocalMcpPrompts } from "./prompts.js";
import { createLocalMcpResources } from "./resources.js";
import type { LocalToolRuntime } from "./runtime.js";

export const createLocalMcpServer = (runtime: LocalToolRuntime): Server => {
  const resources = createLocalMcpResources(runtime);
  const prompts = createLocalMcpPrompts(runtime);
  const toolNames = new Set(
    runtime.definitions.map((definition) => definition.spec.name),
  );
  const instructions = [
    ...(toolNames.has("get_machdoch_state") ? [MACHDOCH_STATE_GUIDANCE] : []),
    ...(toolNames.has("start_agent_session")
      ? [MACHDOCH_AGENT_SESSION_GUIDANCE]
      : []),
  ];
  const server = new Server(
    { name: "machdoch", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        ...(resources.enabled ? { resources: {} } : {}),
        ...(prompts.enabled ? { prompts: {} } : {}),
        ...(resources.enabled || prompts.enabled ? { completions: {} } : {}),
      },
      ...(instructions.length > 0
        ? { instructions: instructions.join("\n\n") }
        : {}),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: runtime.definitions.map(({ effect, spec }) => {
      const readOnly = effect === "read" || effect === "external-read";
      return {
        name: spec.name,
        description: spec.description,
        inputSchema: { ...spec.inputSchema, type: "object" as const },
        annotations: {
          readOnlyHint: readOnly,
          ...(readOnly ? { destructiveHint: false, idempotentHint: true } : {}),
          openWorldHint: effect.startsWith("external-"),
        },
      };
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = request.params._meta?.progressToken;
    let progress = 0;
    try {
      const { toolResult } = await runtime.call(
        request.params.name,
        request.params.arguments ?? {},
        extra.signal,
        progressToken === undefined
          ? undefined
          : (output) =>
              extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: ++progress,
                  message: output.chunk,
                },
              }),
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
  if (resources.enabled) {
    server.setRequestHandler(
      ListResourcesRequestSchema,
      async (_request, extra) => ({
        resources: await resources.list(extra.signal),
      }),
    );
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: resources.templates(),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) =>
      resources.read(request.params.uri, extra.signal),
    );
  }
  if (prompts.enabled) {
    server.setRequestHandler(ListPromptsRequestSchema, async (_request, extra) => ({
      prompts: await prompts.list(extra.signal),
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) =>
      prompts.get(
        request.params.name,
        request.params.arguments ?? {},
        extra.signal,
      ),
    );
  }
  if (resources.enabled || prompts.enabled) {
    server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
      const { ref, argument } = request.params;
      return {
        completion:
          ref.type === "ref/resource"
            ? await resources.complete(
                ref.uri,
                argument.name,
                argument.value,
                extra.signal,
              )
            : { values: [], total: 0, hasMore: false },
      };
    });
  }
  return server;
};
