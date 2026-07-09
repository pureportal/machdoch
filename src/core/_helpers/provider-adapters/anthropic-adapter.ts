import type Anthropic from "@anthropic-ai/sdk";
import type {
  Message as AnthropicMessage,
  MessageParam as AnthropicMessageParam,
  Tool as AnthropicTool,
  ToolUseBlock as AnthropicToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  AgentModelAdapter,
  AgentModelContinueParams,
  AgentModelStartParams,
  AgentModelStreamEventHandler,
  AgentModelToolCall,
  AgentModelToolResult,
  AgentModelToolSpec,
  AgentModelTurn,
} from "../../types.js";
import type {
  ModelProvider,
  ReasoningMode,
} from "../../runtime-contract.generated.js";
import { normalizeReasoningModeForProviderModel } from "../../reasoning-modes.js";
import { TASK_EXECUTION_TIMEOUT_MS } from "../agent-runtime-types.js";
import { hasImageInputs } from "./image-inputs.js";
import { withProviderRequest } from "./request.js";
import {
  emitProviderStreamError,
  emitProviderStreamEvent,
  emitProviderStreamStatus,
  emitToolResultStreamEvents,
  emitUsageStreamEvent,
  normalizeAnthropicUsage,
} from "./stream-events.js";
import { normalizeToolResultContent } from "./tool-result-content.js";

export const createAnthropicToolSelection = () => ({
  tool_choice: {
    type: "any" as const,
    disable_parallel_tool_use: true,
  },
});

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const createAnthropicOutputConfig = (
  model: string,
  reasoning?: ReasoningMode,
): { output_config?: { effort: AnthropicEffort } } => {
  if (!reasoning || reasoning === "default") {
    return {};
  }

  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "anthropic",
    model,
  );

  if (normalizedReasoning === "default") {
    return {};
  }

  return {
    output_config: {
      effort:
        normalizedReasoning === "none" || normalizedReasoning === "minimal"
          ? "low"
          : normalizedReasoning === "ultra"
            ? "max"
            : normalizedReasoning,
    },
  };
};

export const createAnthropicUserContent = (
  params: Pick<AgentModelStartParams, "imageInputs" | "userPrompt">,
): AnthropicMessageParam["content"] => {
  if (!hasImageInputs(params.imageInputs)) {
    return params.userPrompt;
  }

  return [
    ...params.imageInputs.map((imageInput) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: imageInput.mediaType,
        data: imageInput.data,
      },
    })),
    {
      type: "text" as const,
      text: params.userPrompt,
    },
  ] as AnthropicMessageParam["content"];
};

export const createAnthropicTools = (
  tools: AgentModelToolSpec[],
): AnthropicTool[] => {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      ...(tool.inputSchema as Record<string, unknown>),
      type: "object",
    },
    strict: true,
  }));
};

const createAnthropicToolResultContent = (
  toolResult: AgentModelToolResult,
) => {
  const content = normalizeToolResultContent(toolResult).map((contentPart) => {
    if (contentPart.type === "text") {
      return {
        type: "text" as const,
        text: contentPart.text,
      };
    }

    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: contentPart.mediaType,
        data: contentPart.data,
      },
    };
  });

  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }

  return content;
};

export class AnthropicMessagesAdapter implements AgentModelAdapter {
  private readonly client: Anthropic;
  private readonly tools: AgentModelToolSpec[];
  private readonly provider: ModelProvider;
  private readonly messages: AnthropicMessageParam[] = [];
  private startParams?: AgentModelStartParams;

  constructor(
    client: Anthropic,
    tools: AgentModelToolSpec[],
    provider: ModelProvider = "anthropic",
  ) {
    this.client = client;
    this.tools = tools;
    this.provider = provider;
  }

  async startTurn(params: AgentModelStartParams): Promise<AgentModelTurn> {
    this.startParams = params;
    this.messages.length = 0;
    this.messages.push({
      role: "user",
      content: createAnthropicUserContent(params),
    });

    const message = await withProviderRequest(
      {
        provider: this.provider,
        operation: "startTurn",
        signal: params.signal,
      },
      async (requestSignal) => {
        const request = {
          model: params.model,
          max_tokens: 4_096,
          system: params.systemPrompt,
          messages: [...this.messages],
          tools: createAnthropicTools(params.tools),
          ...createAnthropicOutputConfig(params.model, params.reasoning),
          ...createAnthropicToolSelection(),
        };

        if (params.onStreamEvent) {
          return await this.createStreamingMessage(
            request,
            requestSignal,
            params.onStreamEvent,
          );
        }

        return await this.client.messages.create(request, {
          timeout: TASK_EXECUTION_TIMEOUT_MS,
          ...(requestSignal ? { signal: requestSignal } : {}),
        });
      },
    );

    this.messages.push({
      role: "assistant",
      content: message.content as AnthropicMessageParam["content"],
    });

    return this.normalizeResponse(message);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams) {
      throw new Error(
        "The Anthropic adapter cannot continue before it starts.",
      );
    }

    const startParams = this.startParams;
    this.messages.push({
      role: "user",
      content: params.toolResults.map((toolResult) => ({
        type: "tool_result" as const,
        tool_use_id: toolResult.callId,
        content: createAnthropicToolResultContent(toolResult),
        ...(toolResult.isError ? { is_error: true } : {}),
      })) as AnthropicMessageParam["content"],
    });

    emitToolResultStreamEvents(
      params.onStreamEvent,
      this.provider,
      params.toolResults,
    );

    const message = await withProviderRequest(
      {
        provider: this.provider,
        operation: "continueTurn",
        signal: params.signal,
      },
      async (requestSignal) => {
        const request = {
          model: startParams.model,
          max_tokens: 4_096,
          system: startParams.systemPrompt,
          messages: [...this.messages],
          tools: createAnthropicTools(this.tools),
          ...createAnthropicOutputConfig(
            startParams.model,
            startParams.reasoning,
          ),
          ...createAnthropicToolSelection(),
        };

        if (params.onStreamEvent) {
          return await this.createStreamingMessage(
            request,
            requestSignal,
            params.onStreamEvent,
          );
        }

        return await this.client.messages.create(request, {
          timeout: TASK_EXECUTION_TIMEOUT_MS,
          ...(requestSignal ? { signal: requestSignal } : {}),
        });
      },
    );

    this.messages.push({
      role: "assistant",
      content: message.content as AnthropicMessageParam["content"],
    });

    return this.normalizeResponse(message);
  }

  private async createStreamingMessage(
    request: Parameters<Anthropic["messages"]["create"]>[0],
    requestSignal: AbortSignal | undefined,
    onStreamEvent: AgentModelStreamEventHandler,
  ): Promise<AnthropicMessage> {
    emitProviderStreamStatus(
      onStreamEvent,
      this.provider,
      "starting",
      "Anthropic message stream started.",
    );

    const stream = this.client.messages.stream(request, {
      timeout: TASK_EXECUTION_TIMEOUT_MS,
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
    const toolCallsByIndex = new Map<number, AnthropicToolUseBlock>();
    const toolArgumentSnapshotsByIndex = new Map<number, string>();
    const abortStream = (): void => stream.abort();

    requestSignal?.addEventListener("abort", abortStream, { once: true });

    try {
      stream.on("text", (textDelta) => {
        emitProviderStreamEvent(onStreamEvent, {
          type: "text-delta",
          provider: this.provider,
          delta: textDelta,
        });
      });
      stream.on("streamEvent", (event) => {
        if (event.type === "message_start") {
          emitProviderStreamStatus(
            onStreamEvent,
            this.provider,
            "in-progress",
            "Anthropic message stream in progress.",
            event.type,
          );
          emitUsageStreamEvent(
            onStreamEvent,
            this.provider,
            normalizeAnthropicUsage(event.message.usage),
          );
          return;
        }

        if (
          event.type === "content_block_start" &&
          event.content_block.type === "tool_use"
        ) {
          toolCallsByIndex.set(event.index, event.content_block);
          emitProviderStreamEvent(onStreamEvent, {
            type: "tool-call-start",
            provider: this.provider,
            id: event.content_block.id,
            name: event.content_block.name,
          });
          return;
        }

        if (
          event.type === "content_block_delta" &&
          event.delta.type === "input_json_delta"
        ) {
          const toolCall = toolCallsByIndex.get(event.index);
          const previousSnapshot =
            toolArgumentSnapshotsByIndex.get(event.index) ?? "";
          const snapshot = `${previousSnapshot}${event.delta.partial_json}`;

          toolArgumentSnapshotsByIndex.set(event.index, snapshot);
          emitProviderStreamEvent(onStreamEvent, {
            type: "tool-call-arguments-delta",
            provider: this.provider,
            ...(toolCall ? { id: toolCall.id, name: toolCall.name } : {}),
            delta: event.delta.partial_json,
            snapshot,
          });
          return;
        }

        if (
          event.type === "content_block_delta" &&
          event.delta.type === "thinking_delta"
        ) {
          emitProviderStreamEvent(onStreamEvent, {
            type: "reasoning-delta",
            provider: this.provider,
            delta: event.delta.thinking,
          });
          return;
        }

        if (
          event.type === "content_block_delta" &&
          event.delta.type === "signature_delta"
        ) {
          emitProviderStreamEvent(onStreamEvent, {
            type: "reasoning-delta",
            provider: this.provider,
            delta: "",
            signature: event.delta.signature,
          });
          return;
        }

        if (event.type === "content_block_stop") {
          const toolCall = toolCallsByIndex.get(event.index);

          if (!toolCall) {
            return;
          }

          emitProviderStreamEvent(onStreamEvent, {
            type: "tool-call-done",
            provider: this.provider,
            id: toolCall.id,
            name: toolCall.name,
            argumentsText:
              toolArgumentSnapshotsByIndex.get(event.index) ??
              JSON.stringify(toolCall.input),
          });
          return;
        }

        if (event.type === "message_delta") {
          emitUsageStreamEvent(
            onStreamEvent,
            this.provider,
            normalizeAnthropicUsage(event.usage),
          );
          return;
        }

        if (event.type === "message_stop") {
          emitProviderStreamStatus(
            onStreamEvent,
            this.provider,
            "completed",
            "Anthropic message stream completed.",
            event.type,
          );
        }
      });

      return await stream.finalMessage();
    } catch (error) {
      emitProviderStreamError(onStreamEvent, this.provider, error);
      throw error;
    } finally {
      requestSignal?.removeEventListener("abort", abortStream);
    }
  }

  private normalizeResponse(
    message: Pick<AnthropicMessage, "content" | "stop_reason">,
  ): AgentModelTurn {
    const toolCalls: AgentModelToolCall[] = [];
    const textParts: string[] = [];

    for (const contentBlock of message.content) {
      if (
        contentBlock.type === "text" &&
        typeof contentBlock.text === "string"
      ) {
        textParts.push(contentBlock.text);
        continue;
      }

      if (contentBlock.type !== "tool_use") {
        continue;
      }

      toolCalls.push({
        id: contentBlock.id ?? crypto.randomUUID(),
        name: contentBlock.name ?? "unknown_tool",
        arguments:
          typeof contentBlock.input === "object" && contentBlock.input !== null
            ? (contentBlock.input as Record<string, unknown>)
            : {},
      });
    }

    return {
      text: textParts.join("\n").trim(),
      toolCalls,
      ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
    };
  }
}
