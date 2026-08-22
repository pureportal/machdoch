import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionUserMessageParam,
} from "openai/resources/chat/completions";
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
import type { ReasoningMode } from "../../runtime-contract.generated.js";
import { normalizeReasoningModeForProviderModel } from "../../reasoning-modes.js";
import { hasImageInputs } from "./image-inputs.js";
import { withProviderRequest } from "./request.js";
import { normalizeOpenAIStrictInputSchema } from "./schema-normalization.js";
import {
  emitProviderStreamError,
  emitProviderStreamEvent,
  emitProviderStreamStatus,
  emitToolResultStreamEvents,
  emitUsageStreamEvent,
  normalizeOpenAIUsage,
} from "./stream-events.js";
import { normalizeToolResultContent } from "./tool-result-content.js";

type LangdockReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

type LangdockChatRequest = Omit<
  ChatCompletionCreateParamsNonStreaming,
  "stream"
>;

interface LangdockStreamingToolCall {
  index: number;
  id: string;
  name: string;
  argumentsText: string;
  emittedStart: boolean;
}

export const createLangdockTools = (
  tools: AgentModelToolSpec[],
): ChatCompletionTool[] => {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters:
        tool.strict === false
          ? tool.inputSchema
          : normalizeOpenAIStrictInputSchema(tool.inputSchema),
      strict: tool.strict !== false,
    },
  }));
};

export const createLangdockToolSelection = (
  tools: AgentModelToolSpec[],
): Pick<ChatCompletionCreateParamsNonStreaming, "tool_choice"> => {
  return tools.length > 0 ? { tool_choice: "required" } : {};
};

export const createLangdockReasoningConfig = (
  model: string,
  reasoning?: ReasoningMode,
): { reasoning_effort?: LangdockReasoningEffort } => {
  if (!reasoning || reasoning === "default") {
    return {};
  }

  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "langdock",
    model,
  );

  if (normalizedReasoning === "default") {
    return {};
  }

  return {
    reasoning_effort:
      normalizedReasoning === "ultra"
        ? "max"
        : normalizedReasoning === "max" &&
            !/^gpt-5\.6(?:-|$)/iu.test(model.trim())
          ? "xhigh"
          : normalizedReasoning,
  };
};

export const createLangdockStructuredOutputConfig = (
  structuredOutput: AgentModelStartParams["structuredOutput"],
): Pick<ChatCompletionCreateParamsNonStreaming, "response_format"> => {
  return structuredOutput ? { response_format: { type: "json_object" } } : {};
};

const createLangdockUserMessage = (
  params: Pick<AgentModelStartParams, "imageInputs" | "userPrompt">,
): ChatCompletionUserMessageParam => {
  if (!hasImageInputs(params.imageInputs)) {
    return {
      role: "user",
      content: params.userPrompt,
    };
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: params.userPrompt,
      },
      ...params.imageInputs.map((imageInput) => ({
        type: "image_url" as const,
        image_url: {
          url: `data:${imageInput.mediaType};base64,${imageInput.data}`,
          detail:
            imageInput.detail === "original"
              ? "high"
              : (imageInput.detail ?? "auto"),
        },
      })),
    ],
  };
};

const parseToolArguments = (
  rawArguments: string | undefined,
): Record<string, unknown> => {
  if (!rawArguments) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;

    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const createLangdockToolMessageContent = (
  toolResult: AgentModelToolResult,
): string => {
  const content = normalizeToolResultContent(toolResult);
  const textParts = content
    .filter((contentPart) => contentPart.type === "text")
    .map((contentPart) => contentPart.text);
  const imageParts = content.filter((contentPart) => contentPart.type === "image");
  const lines = [...textParts];

  for (const imagePart of imageParts) {
    lines.push(`[image result omitted: ${imagePart.mediaType}]`);
  }

  return (
    lines.join("\n\n").trim() ||
    toolResult.output.trim() ||
    "Tool completed without textual output."
  );
};

const createAssistantMessage = (
  response: ChatCompletion,
): ChatCompletionAssistantMessageParam => {
  const message = response.choices[0]?.message;

  return {
    role: "assistant",
    content: message?.content ?? null,
    ...(message?.tool_calls ? { tool_calls: message.tool_calls } : {}),
  };
};

export class LangdockChatCompletionsAdapter implements AgentModelAdapter {
  private readonly client: OpenAI;
  private readonly tools: AgentModelToolSpec[];
  private messages: ChatCompletionMessageParam[] = [];
  private startParams?: AgentModelStartParams;

  constructor(client: OpenAI, tools: AgentModelToolSpec[]) {
    this.client = client;
    this.tools = tools;
  }

  async startTurn(params: AgentModelStartParams): Promise<AgentModelTurn> {
    this.startParams = params;
    this.messages = [
      {
        role: "system",
        content: params.systemPrompt,
      },
      createLangdockUserMessage(params),
    ];

    const response = await withProviderRequest(
      {
        provider: "langdock",
        operation: "startTurn",
        signal: params.signal,
      },
      async (requestSignal) => {
        const request = this.createRequest(params, this.messages, params.tools);

        if (params.onStreamEvent) {
          return await this.createStreamingResponse(
            request,
            requestSignal,
            params.onStreamEvent,
          );
        }

        return await this.client.chat.completions.create(request, {
          ...(requestSignal ? { signal: requestSignal } : {}),
        });
      },
    );

    this.messages.push(createAssistantMessage(response));
    return this.normalizeResponse(response);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams) {
      throw new Error("The Langdock adapter cannot continue before it starts.");
    }

    const startParams = this.startParams;

    emitToolResultStreamEvents(
      params.onStreamEvent,
      "langdock",
      params.toolResults,
    );

    this.messages.push(
      ...params.toolResults.map(
        (toolResult): ChatCompletionMessageParam => ({
          role: "tool",
          tool_call_id: toolResult.callId,
          content: createLangdockToolMessageContent(toolResult),
        }),
      ),
    );

    const response = await withProviderRequest(
      {
        provider: "langdock",
        operation: "continueTurn",
        signal: params.signal,
      },
      async (requestSignal) => {
        const request = this.createRequest(
          startParams,
          this.messages,
          this.tools,
        );

        if (params.onStreamEvent) {
          return await this.createStreamingResponse(
            request,
            requestSignal,
            params.onStreamEvent,
          );
        }

        return await this.client.chat.completions.create(request, {
          ...(requestSignal ? { signal: requestSignal } : {}),
        });
      },
    );

    this.messages.push(createAssistantMessage(response));
    return this.normalizeResponse(response);
  }

  private createRequest(
    params: AgentModelStartParams,
    messages: ChatCompletionMessageParam[],
    tools: AgentModelToolSpec[],
  ): LangdockChatRequest {
    const chatTools = createLangdockTools(tools);

    return {
      model: params.model,
      messages: [...messages],
      ...(chatTools.length > 0 ? { tools: chatTools } : {}),
      ...createLangdockToolSelection(tools),
      // Langdock rejects Chat Completions requests that combine function tools
      // with reasoning_effort; Machdoch tool turns must keep function tools.
      ...(chatTools.length === 0
        ? createLangdockReasoningConfig(params.model, params.reasoning)
        : {}),
      ...createLangdockStructuredOutputConfig(params.structuredOutput),
    };
  }

  private async createStreamingResponse(
    request: LangdockChatRequest,
    requestSignal: AbortSignal | undefined,
    onStreamEvent: AgentModelStreamEventHandler,
  ): Promise<ChatCompletion> {
    emitProviderStreamStatus(
      onStreamEvent,
      "langdock",
      "starting",
      "Langdock chat completion stream started.",
    );

    const streamRequest: ChatCompletionCreateParamsStreaming = {
      ...request,
      stream: true,
    };
    const textParts: string[] = [];
    const toolCallsByIndex = new Map<number, LangdockStreamingToolCall>();
    let responseId: string = crypto.randomUUID();
    let responseCreated = Math.floor(Date.now() / 1000);
    let didEmitInProgress = false;
    let usage: unknown;

    const emitInProgress = (rawEventType?: string): void => {
      if (didEmitInProgress) {
        return;
      }

      didEmitInProgress = true;
      emitProviderStreamStatus(
        onStreamEvent,
        "langdock",
        "in-progress",
        "Langdock chat completion stream in progress.",
        rawEventType,
      );
    };

    try {
      const stream = await this.client.chat.completions.create(streamRequest, {
        ...(requestSignal ? { signal: requestSignal } : {}),
      });

      for await (const chunk of stream) {
        responseId = chunk.id || responseId;
        responseCreated = chunk.created || responseCreated;
        usage =
          (chunk as ChatCompletionChunk & { usage?: unknown }).usage ?? usage;
        emitInProgress("chat.completion.chunk");

        for (const choice of chunk.choices) {
          const contentDelta = choice.delta.content;

          if (typeof contentDelta === "string" && contentDelta.length > 0) {
            textParts.push(contentDelta);
            emitProviderStreamEvent(onStreamEvent, {
              type: "text-delta",
              provider: "langdock",
              delta: contentDelta,
            });
          }

          for (const deltaToolCall of choice.delta.tool_calls ?? []) {
            const index = deltaToolCall.index;
            const existing = toolCallsByIndex.get(index);
            const id = deltaToolCall.id ?? existing?.id ?? crypto.randomUUID();
            const name =
              deltaToolCall.function?.name ??
              existing?.name ??
              "unknown_tool";
            const argumentsDelta = deltaToolCall.function?.arguments ?? "";
            const toolCall: LangdockStreamingToolCall = {
              index,
              id,
              name,
              argumentsText: `${existing?.argumentsText ?? ""}${argumentsDelta}`,
              emittedStart: existing?.emittedStart ?? false,
            };

            if (!toolCall.emittedStart) {
              toolCall.emittedStart = true;
              emitProviderStreamEvent(onStreamEvent, {
                type: "tool-call-start",
                provider: "langdock",
                id,
                name,
              });
            }

            if (argumentsDelta.length > 0) {
              emitProviderStreamEvent(onStreamEvent, {
                type: "tool-call-arguments-delta",
                provider: "langdock",
                id,
                name,
                delta: argumentsDelta,
                snapshot: toolCall.argumentsText,
              });
            }

            toolCallsByIndex.set(index, toolCall);
          }
        }
      }

      for (const toolCall of toolCallsByIndex.values()) {
        emitProviderStreamEvent(onStreamEvent, {
          type: "tool-call-done",
          provider: "langdock",
          id: toolCall.id,
          name: toolCall.name,
          argumentsText: toolCall.argumentsText,
        });
      }

      emitUsageStreamEvent(onStreamEvent, "langdock", normalizeOpenAIUsage(usage));
      emitProviderStreamStatus(
        onStreamEvent,
        "langdock",
        "completed",
        "Langdock chat completion stream completed.",
      );

      const response: ChatCompletion = {
        id: responseId,
        object: "chat.completion",
        created: responseCreated,
        model: request.model.toString(),
        choices: [
          {
            index: 0,
            finish_reason:
              toolCallsByIndex.size > 0 ? "tool_calls" : "stop",
            logprobs: null,
            message: {
              role: "assistant",
              content: textParts.join(""),
              refusal: null,
              tool_calls: [...toolCallsByIndex.values()].map((toolCall) => ({
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.name,
                  arguments: toolCall.argumentsText,
                },
              })),
            },
          },
        ],
      };

      if (usage !== undefined) {
        response.usage = usage as NonNullable<ChatCompletion["usage"]>;
      }

      return response;
    } catch (error) {
      emitProviderStreamError(onStreamEvent, "langdock", error);
      throw error;
    }
  }

  private normalizeResponse(response: ChatCompletion): AgentModelTurn {
    const message = response.choices[0]?.message;
    const toolCalls: AgentModelToolCall[] = [];

    for (const toolCall of message?.tool_calls ?? []) {
      if (toolCall.type !== "function") {
        continue;
      }

      toolCalls.push({
        id: toolCall.id || crypto.randomUUID(),
        name: toolCall.function.name || "unknown_tool",
        arguments: parseToolArguments(toolCall.function.arguments),
        ...(toolCall.function.arguments
          ? { rawArguments: toolCall.function.arguments }
          : {}),
      });
    }

    return {
      text: message?.content?.trim() ?? "",
      toolCalls,
    };
  }
}
