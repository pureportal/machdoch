import { decodeToolArguments } from "./tool-arguments.ts";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  Message as AnthropicMessage,
  MessageParam as AnthropicMessageParam,
  TextBlockParam as AnthropicTextBlockParam,
  ThinkingConfigParam,
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
} from "../types.ts";
import type { ConfiguredModelProvider, ReasoningMode } from "../types.ts";
import { assertReasoningModeSupportedForProviderModel } from "../reasoning-modes.ts";
import { hasImageInputs } from "./image-inputs.ts";
import { withProviderRequest } from "./request.ts";
import {
  emitProviderStreamError,
  emitProviderStreamEvent,
  emitProviderStreamStatus,
  emitToolResultStreamEvents,
  emitUsageStreamEvent,
  normalizeAnthropicUsage,
} from "./stream-events.ts";
import { normalizeToolResultContent } from "./tool-result-content.ts";
import { resolveProviderPromptCacheDirectives } from "../provider-prompt-cache.ts";
import {
  getDiscoveredModelCapabilities,
  getModelCapabilityProfile,
} from "../model-capabilities.ts";
import { normalizeModelId } from "../normalize-model-id.ts";

const ADAPTIVE_THINKING_MODEL_PATTERN =
  /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-5|5-(?:fable|mythos|opus|sonnet|haiku)|opus-4-[678]|4-[678]-opus|sonnet-4-6|4-6-sonnet|mythos-preview)(?:-|$)/u;

export const supportsAnthropicAdaptiveThinking = (model: string): boolean =>
  ADAPTIVE_THINKING_MODEL_PATTERN.test(normalizeModelId(model));

export const createAnthropicToolSelection = (
  model: string,
  tools: readonly AgentModelToolSpec[],
  choice: "auto" | "required" = "required",
) =>
  tools.length > 0
    ? {
        tool_choice: {
          type:
            choice === "auto" || supportsAnthropicAdaptiveThinking(model)
              ? ("auto" as const)
              : ("any" as const),
          disable_parallel_tool_use: true,
        },
      }
    : {};

export const createAnthropicThinkingConfig = (
  model: string,
): { thinking?: ThinkingConfigParam } =>
  supportsAnthropicAdaptiveThinking(model)
    ? { thinking: { type: "adaptive", display: "summarized" } }
    : {};

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

const ANTHROPIC_STREAMING_MAX_OUTPUT_TOKENS = 64_000;
const ANTHROPIC_NON_STREAMING_MAX_OUTPUT_TOKENS = 16_000;

export const getAnthropicMaxOutputTokens = (
  provider: ConfiguredModelProvider,
  model: string,
  streaming: boolean,
): number => {
  const requested = streaming
    ? ANTHROPIC_STREAMING_MAX_OUTPUT_TOKENS
    : ANTHROPIC_NON_STREAMING_MAX_OUTPUT_TOKENS;
  const modelLimit =
    getDiscoveredModelCapabilities(provider, model)?.maxOutputTokens ??
    getModelCapabilityProfile(provider, model)?.maxOutputTokens;

  return modelLimit && modelLimit > 0 ? Math.min(requested, modelLimit) : requested;
};

export const createAnthropicOutputConfig = (
  model: string,
  reasoning?: ReasoningMode,
  provider: ConfiguredModelProvider = "anthropic",
  structuredOutput?: AgentModelStartParams["structuredOutput"],
): {
  output_config?: {
    effort?: AnthropicEffort;
    format?: { type: "json_schema"; schema: Record<string, unknown> };
  };
} => {
  if ((!reasoning || reasoning === "default") && !structuredOutput) {
    return {};
  }

  if (reasoning && reasoning !== "default") {
    assertReasoningModeSupportedForProviderModel(reasoning, provider, model);
  }

  return {
    output_config: {
      ...(reasoning && reasoning !== "default"
        ? { effort: reasoning as AnthropicEffort }
        : {}),
      ...(structuredOutput
        ? {
            format: {
              type: "json_schema" as const,
              schema: structuredOutput.schema as Record<string, unknown>,
            },
          }
        : {}),
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

export const createAnthropicSystemPrompt = (
  provider: ConfiguredModelProvider,
  model: string,
  systemPrompt: string,
  tools: readonly AgentModelToolSpec[],
): string | AnthropicTextBlockParam[] => {
  const cache = resolveProviderPromptCacheDirectives(
    provider,
    model,
    systemPrompt,
    tools,
  );

  return cache.cacheSystemPrompt
    ? [
        {
          type: "text" as const,
          text: systemPrompt,
          cache_control: { type: "ephemeral" as const },
        },
      ]
    : systemPrompt;
};

const createAnthropicToolResultContent = (toolResult: AgentModelToolResult) => {
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

const withAnthropicConversationCacheBreakpoint = (
  messages: readonly AnthropicMessageParam[],
): AnthropicMessageParam[] => {
  const lastMessage = messages.at(-1);

  if (!lastMessage) {
    return [];
  }

  const content =
    typeof lastMessage.content === "string"
      ? [{ type: "text" as const, text: lastMessage.content }]
      : lastMessage.content;
  const lastBlock = content.at(-1);

  if (!lastBlock || lastBlock.type === "thinking" || lastBlock.type === "redacted_thinking") {
    return [...messages];
  }

  return [
    ...messages.slice(0, -1),
    {
      ...lastMessage,
      content: [
        ...content.slice(0, -1),
        { ...lastBlock, cache_control: { type: "ephemeral" as const } },
      ],
    } as AnthropicMessageParam,
  ];
};

export const createAnthropicRefusalError = (
  message: Pick<AnthropicMessage, "stop_details">,
): Error => {
  const details = message.stop_details;
  const category = details?.category ? ` (${details.category})` : "";
  const explanation = details?.explanation ? ` ${details.explanation}` : "";

  return new Error(`Claude declined this request${category}.${explanation}`);
};

const TRUNCATED_TOOL_CALL_ERROR =
  "The response reached the output token limit before this tool call was complete, so it was not run. Retry with smaller arguments, for example by splitting large file contents across several calls.";

export class AnthropicMessagesAdapter implements AgentModelAdapter {
  private readonly client: Anthropic;
  private readonly tools: AgentModelToolSpec[];
  private readonly provider: ConfiguredModelProvider;
  private readonly messages: AnthropicMessageParam[] = [];
  private startParams?: AgentModelStartParams;

  constructor(
    client: Anthropic,
    tools: AgentModelToolSpec[],
    provider: ConfiguredModelProvider = "anthropic",
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

    return await this.requestTurn(params, params.tools, "startTurn", params);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams) {
      throw new Error(
        "The Anthropic adapter cannot continue before it starts.",
      );
    }

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

    return await this.requestTurn(
      this.startParams,
      this.tools,
      "continueTurn",
      params,
    );
  }

  private async requestTurn(
    startParams: AgentModelStartParams,
    tools: readonly AgentModelToolSpec[],
    operation: "startTurn" | "continueTurn",
    callParams: Pick<
      AgentModelContinueParams,
      "signal" | "onStreamEvent" | "onRequestAttempt"
    >,
  ): Promise<AgentModelTurn> {
    const { onStreamEvent } = callParams;
    const cacheDirectives = resolveProviderPromptCacheDirectives(
      this.provider,
      startParams.model,
      startParams.systemPrompt,
      tools,
    );
    const message = await withProviderRequest(
      {
        provider: this.provider,
        operation,
        maxAttempts: startParams.maxRequestAttempts ?? 3,
        signal: callParams.signal,
        ...(callParams.onRequestAttempt
          ? { logger: callParams.onRequestAttempt }
          : {}),
      },
      async (requestSignal) => {
        const request = {
          model: startParams.model,
          max_tokens:
            startParams.maxOutputTokens ??
            getAnthropicMaxOutputTokens(
              this.provider,
              startParams.model,
              onStreamEvent !== undefined,
            ),
          system: createAnthropicSystemPrompt(
            this.provider,
            startParams.model,
            startParams.systemPrompt,
            tools,
          ),
          messages: cacheDirectives.cacheSystemPrompt
            ? withAnthropicConversationCacheBreakpoint(this.messages)
            : [...this.messages],
          ...(tools.length > 0
            ? {
                tools: createAnthropicTools([...tools]),
                ...createAnthropicToolSelection(
                  startParams.model,
                  tools,
                  startParams.toolChoice,
                ),
              }
            : {}),
          ...createAnthropicThinkingConfig(startParams.model),
          ...createAnthropicOutputConfig(
            startParams.model,
            startParams.reasoning,
            this.provider,
            startParams.structuredOutput,
          ),
        };

        if (onStreamEvent) {
          return await this.createStreamingMessage(
            request,
            requestSignal,
            onStreamEvent,
          );
        }

        return await this.client.messages.create(request, {
          ...(requestSignal ? { signal: requestSignal } : {}),
        });
      },
    );

    this.messages.push({
      role: "assistant",
      content: message.content as AnthropicMessageParam["content"],
    });

    if (message.stop_reason === "refusal") {
      throw createAnthropicRefusalError(message);
    }

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
    message: Pick<AnthropicMessage, "content" | "stop_reason" | "usage">,
  ): AgentModelTurn {
    const toolCalls: AgentModelToolCall[] = [];
    const textParts: string[] = [];
    const usage = normalizeAnthropicUsage(message.usage);

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
        ...decodeToolArguments(contentBlock.input),
        ...(message.stop_reason === "max_tokens"
          ? { argumentError: TRUNCATED_TOOL_CALL_ERROR }
          : {}),
      });
    }

    return {
      text: textParts.join("\n").trim(),
      toolCalls,
      ...(message.stop_reason ? { stopReason: message.stop_reason } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
