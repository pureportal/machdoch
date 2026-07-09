import type OpenAI from "openai";
import type {
  BetaResponse,
  BetaResponseStreamEvent,
  ResponseCreateParamsNonStreaming as BetaResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming as BetaResponseCreateParamsStreaming,
} from "openai/resources/beta/responses/responses";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
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
import { TASK_EXECUTION_TIMEOUT_MS } from "../agent-runtime-types.js";
import { hasImageInputs } from "./image-inputs.js";
import { withProviderRequest } from "./request.js";
import { normalizeOpenAIStrictInputSchema } from "./schema-normalization.js";
import {
  emitProviderStreamError,
  emitProviderStreamEvent,
  emitProviderStreamStatus,
  emitToolResultStreamEvents,
  emitUsageStreamEvent,
  getProviderEventString,
  normalizeOpenAIUsage,
} from "./stream-events.js";
import { normalizeToolResultContent } from "./tool-result-content.js";

export const createOpenAITools = (tools: AgentModelToolSpec[]) => {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters:
      tool.strict === false
        ? tool.inputSchema
        : normalizeOpenAIStrictInputSchema(tool.inputSchema),
    strict: tool.strict !== false,
  }));
};

export const createOpenAIResponseToolSelection = () => ({
  parallel_tool_calls: false,
  tool_choice: "required" as const,
});

type OpenAIReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const OPENAI_MULTI_AGENT_BETA = "responses_multi_agent=v1" as const;
const OPENAI_ULTRA_MAX_CONCURRENT_SUBAGENTS = 4;

export const createOpenAIReasoningConfig = (
  model: string,
  reasoning?: ReasoningMode,
): { reasoning?: { effort: OpenAIReasoningEffort } } => {
  if (!reasoning || reasoning === "default") {
    return {};
  }

  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "openai",
    model,
  );

  if (normalizedReasoning === "default") {
    return {};
  }

  return {
    reasoning: {
      effort: normalizedReasoning === "ultra" ? "max" : normalizedReasoning,
    },
  };
};

export const createOpenAIMultiAgentConfig = (
  model: string,
  reasoning?: ReasoningMode,
): Pick<
  BetaResponseCreateParamsNonStreaming,
  "betas" | "multi_agent"
> => {
  if (!reasoning || reasoning === "default") {
    return {};
  }

  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "openai",
    model,
  );

  if (normalizedReasoning !== "ultra") {
    return {};
  }

  return {
    multi_agent: {
      enabled: true,
      max_concurrent_subagents: OPENAI_ULTRA_MAX_CONCURRENT_SUBAGENTS,
    },
    betas: [OPENAI_MULTI_AGENT_BETA],
  };
};

const normalizeOpenAIStructuredOutputName = (name: string): string => {
  const normalized = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);

  return normalized || "structured_output";
};

const isSchemaRecord = (schema: unknown): schema is Record<string, unknown> => {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema);
};

const normalizeOpenAIStructuredOutputSchema = (
  structuredOutput: AgentModelStartParams["structuredOutput"],
): unknown => {
  if (
    structuredOutput?.strict === false ||
    !isSchemaRecord(structuredOutput?.schema)
  ) {
    return structuredOutput?.schema;
  }

  return normalizeOpenAIStrictInputSchema(structuredOutput.schema);
};

export const createOpenAIStructuredOutputTextConfig = (
  structuredOutput: AgentModelStartParams["structuredOutput"],
): { text?: Record<string, unknown> } => {
  if (!structuredOutput) {
    return {};
  }

  return {
    text: {
      format: {
        type: "json_schema",
        name: normalizeOpenAIStructuredOutputName(structuredOutput.name),
        schema: normalizeOpenAIStructuredOutputSchema(structuredOutput),
        strict: structuredOutput.strict !== false,
      },
    },
  };
};

export const createOpenAIUserInput = (
  params: Pick<AgentModelStartParams, "imageInputs" | "userPrompt">,
) => {
  if (!hasImageInputs(params.imageInputs)) {
    return params.userPrompt;
  }

  return [
    {
      role: "user" as const,
      content: [
        {
          type: "input_text" as const,
          text: params.userPrompt,
        },
        ...params.imageInputs.map((imageInput) => ({
          type: "input_image" as const,
          detail: imageInput.detail ?? "auto",
          image_url: `data:${imageInput.mediaType};base64,${imageInput.data}`,
        })),
      ],
    },
  ];
};

type OpenAIResponseOutputItemLike = {
  agent?: { agent_name?: string | null } | null;
  phase?: string | null;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  type?: string;
  name?: string;
  arguments?: unknown;
  call_id?: string | null;
};

type OpenAIResponseLike = {
  id: string;
  usage?: unknown;
  output?: OpenAIResponseOutputItemLike[];
  output_text?: string | undefined;
};

type OpenAIStreamEvent = ResponseStreamEvent | BetaResponseStreamEvent;

interface OpenAIResponseStreamLike {
  abort: () => void;
  on: (
    eventName: "event",
    handler: (event: OpenAIStreamEvent) => void,
  ) => void;
  finalResponse: () => Promise<OpenAIResponseLike>;
}

const getOpenAIResponseText = (response: OpenAIResponseLike): string => {
  const rootMessages = (response.output ?? []).filter(
    (item) =>
      item.type === "message" &&
      (!item.agent?.agent_name || item.agent.agent_name === "/root"),
  );
  const finalMessages = rootMessages.filter(
    (item) => item.phase === "final_answer",
  );
  const visibleMessages = finalMessages.length > 0 ? finalMessages : rootMessages;
  const rootText = visibleMessages
    .flatMap((item) => item.content ?? [])
    .filter(
      (part): part is { type?: string; text: string } =>
        part.type === "output_text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim();

  return rootText || response.output_text?.trim() || "";
};

const isRootOpenAIStreamEvent = (
  event: ResponseStreamEvent | BetaResponseStreamEvent,
): boolean => {
  const agent = (
    event as ResponseStreamEvent & {
      agent?: { agent_name?: string | null } | null;
    }
  ).agent;

  return !agent?.agent_name || agent.agent_name === "/root";
};

const createOpenAIFunctionCallOutput = (toolResult: AgentModelToolResult) => {
  const content = normalizeToolResultContent(toolResult);

  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }

  return content.map((contentPart) => {
    if (contentPart.type === "text") {
      return {
        type: "input_text" as const,
        text: contentPart.text,
      };
    }

    return {
      type: "input_image" as const,
      detail: contentPart.detail ?? "original",
      image_url: `data:${contentPart.mediaType};base64,${contentPart.data}`,
    };
  });
};

export class OpenAIResponsesAdapter implements AgentModelAdapter {
  private readonly client: OpenAI;
  private readonly tools: AgentModelToolSpec[];
  private previousResponseId?: string;
  private startParams?: AgentModelStartParams;

  constructor(client: OpenAI, tools: AgentModelToolSpec[]) {
    this.client = client;
    this.tools = tools;
  }

  async startTurn(params: AgentModelStartParams): Promise<AgentModelTurn> {
    this.startParams = params;

    const response = await withProviderRequest(
      {
        provider: "openai",
        operation: "startTurn",
        signal: params.signal,
      },
      async (requestSignal) => {
        const request = {
          model: params.model,
          instructions: params.systemPrompt,
          input: createOpenAIUserInput(params),
          tools: createOpenAITools(params.tools),
          ...createOpenAIReasoningConfig(params.model, params.reasoning),
          ...createOpenAIMultiAgentConfig(params.model, params.reasoning),
          ...createOpenAIStructuredOutputTextConfig(params.structuredOutput),
          ...createOpenAIResponseToolSelection(),
        };

        if (params.onStreamEvent) {
          return await this.createStreamingResponse(
            request,
            requestSignal,
            params.onStreamEvent,
          );
        }

        if (request.multi_agent?.enabled) {
          return await this.client.beta.responses.create(request, {
            timeout: TASK_EXECUTION_TIMEOUT_MS,
            ...(requestSignal ? { signal: requestSignal } : {}),
          });
        }

        return await this.client.responses.create(request, {
          timeout: TASK_EXECUTION_TIMEOUT_MS,
          ...(requestSignal ? { signal: requestSignal } : {}),
        });
      },
    );

    this.previousResponseId = response.id;
    return this.normalizeResponse(response);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams || !this.previousResponseId) {
      throw new Error("The OpenAI adapter cannot continue before it starts.");
    }

    const startParams = this.startParams;
    const previousResponseId = this.previousResponseId;

    emitToolResultStreamEvents(
      params.onStreamEvent,
      "openai",
      params.toolResults,
    );

    const response = await withProviderRequest(
      {
        provider: "openai",
        operation: "continueTurn",
        signal: params.signal,
      },
      async (requestSignal) => {
        const request = {
          model: startParams.model,
          instructions: startParams.systemPrompt,
          previous_response_id: previousResponseId,
          input: params.toolResults.map((toolResult) => ({
            type: "function_call_output" as const,
            call_id: toolResult.callId,
            output: createOpenAIFunctionCallOutput(toolResult),
          })),
          tools: createOpenAITools(this.tools),
          ...createOpenAIReasoningConfig(
            startParams.model,
            startParams.reasoning,
          ),
          ...createOpenAIMultiAgentConfig(
            startParams.model,
            startParams.reasoning,
          ),
          ...createOpenAIStructuredOutputTextConfig(startParams.structuredOutput),
          ...createOpenAIResponseToolSelection(),
        };

        if (params.onStreamEvent) {
          return await this.createStreamingResponse(
            request,
            requestSignal,
            params.onStreamEvent,
          );
        }

        if (request.multi_agent?.enabled) {
          return await this.client.beta.responses.create(request, {
            timeout: TASK_EXECUTION_TIMEOUT_MS,
            ...(requestSignal ? { signal: requestSignal } : {}),
          });
        }

        return await this.client.responses.create(request, {
          timeout: TASK_EXECUTION_TIMEOUT_MS,
          ...(requestSignal ? { signal: requestSignal } : {}),
        });
      },
    );

    this.previousResponseId = response.id;
    return this.normalizeResponse(response);
  }

  private async createStreamingResponse(
    request: Record<string, unknown>,
    requestSignal: AbortSignal | undefined,
    onStreamEvent: AgentModelStreamEventHandler,
  ): Promise<OpenAIResponseLike> {
    emitProviderStreamStatus(
      onStreamEvent,
      "openai",
      "starting",
      "OpenAI response stream started.",
    );

    const multiAgent = request.multi_agent as
      | { enabled?: boolean }
      | null
      | undefined;
    const stream = multiAgent?.enabled
      ? await this.createMultiAgentResponseStream(request, requestSignal)
      : this.createStandardResponseStream(request, requestSignal);
    const toolNamesByItemId = new Map<string, string>();
    const abortStream = (): void => stream.abort();
    let didEmitFinalUsage = false;

    const emitOpenAIUsage = (usage: unknown): void => {
      const normalizedUsage = normalizeOpenAIUsage(usage);

      if (!normalizedUsage) {
        return;
      }

      didEmitFinalUsage = true;
      emitUsageStreamEvent(onStreamEvent, "openai", normalizedUsage);
    };

    requestSignal?.addEventListener("abort", abortStream, { once: true });

    try {
      stream.on("event", (event) => {
        const rawEvent = event as unknown as Record<string, unknown>;

        switch (event.type) {
          case "response.created":
            emitProviderStreamStatus(
              onStreamEvent,
              "openai",
              "in-progress",
              "OpenAI response created.",
              event.type,
            );
            return;
          case "response.queued":
            emitProviderStreamStatus(
              onStreamEvent,
              "openai",
              "queued",
              "OpenAI response queued.",
              event.type,
            );
            return;
          case "response.in_progress":
            emitProviderStreamStatus(
              onStreamEvent,
              "openai",
              "in-progress",
              "OpenAI response in progress.",
              event.type,
            );
            return;
          case "response.completed":
            emitProviderStreamStatus(
              onStreamEvent,
              "openai",
              "completed",
              "OpenAI response stream completed.",
              event.type,
            );
            emitOpenAIUsage(
              (rawEvent.response as { usage?: unknown } | undefined)?.usage,
            );
            return;
          case "response.failed":
          case "response.incomplete":
            emitProviderStreamError(
              onStreamEvent,
              "openai",
              rawEvent.response ?? event,
            );
            return;
          case "error":
            emitProviderStreamError(onStreamEvent, "openai", event);
            return;
          case "response.output_text.delta":
            if (!isRootOpenAIStreamEvent(event)) {
              return;
            }

            emitProviderStreamEvent(onStreamEvent, {
              type: "text-delta",
              provider: "openai",
              delta: event.delta,
            });
            return;
          case "response.output_item.added":
          case "response.output_item.done": {
            const item = event.item as {
              id?: string | null;
              type?: string;
              name?: string;
            };

            if (item.type !== "function_call") {
              return;
            }

            const itemId = item.id ?? undefined;
            const name = item.name ?? undefined;

            if (itemId && name) {
              toolNamesByItemId.set(itemId, name);
            }

            if (event.type === "response.output_item.done") {
              return;
            }

            emitProviderStreamEvent(onStreamEvent, {
              type: "tool-call-start",
              provider: "openai",
              ...(itemId ? { id: itemId } : {}),
              ...(name ? { name } : { name: "unknown_tool" }),
            });
            return;
          }
          case "response.function_call_arguments.delta": {
            const name = toolNamesByItemId.get(event.item_id);

            emitProviderStreamEvent(onStreamEvent, {
              type: "tool-call-arguments-delta",
              provider: "openai",
              id: event.item_id,
              ...(name ? { name } : {}),
              delta: event.delta,
            });
            return;
          }
          case "response.function_call_arguments.done": {
            const name =
              event.name ??
              toolNamesByItemId.get(event.item_id) ??
              "unknown_tool";

            emitProviderStreamEvent(onStreamEvent, {
              type: "tool-call-done",
              provider: "openai",
              id: event.item_id,
              name,
              argumentsText: event.arguments,
            });
            return;
          }
        }

        if (
          event.type.includes("reasoning") &&
          isRootOpenAIStreamEvent(event)
        ) {
          const delta =
            getProviderEventString(event, "delta") ??
            getProviderEventString(event, "text") ??
            getProviderEventString(event, "summary_text");

          if (delta) {
            emitProviderStreamEvent(onStreamEvent, {
              type: "reasoning-delta",
              provider: "openai",
              delta,
            });
          }
        }
      });

      const response = await stream.finalResponse();

      if (!didEmitFinalUsage) {
        emitOpenAIUsage(response.usage);
      }

      return response;
    } catch (error) {
      emitProviderStreamError(onStreamEvent, "openai", error);
      throw error;
    } finally {
      requestSignal?.removeEventListener("abort", abortStream);
    }
  }

  private createStandardResponseStream(
    request: Record<string, unknown>,
    requestSignal: AbortSignal | undefined,
  ): OpenAIResponseStreamLike {
    const stream = this.client.responses.stream(request, {
      timeout: TASK_EXECUTION_TIMEOUT_MS,
      ...(requestSignal ? { signal: requestSignal } : {}),
    });

    return {
      abort: () => stream.abort(),
      on: (_eventName, handler) => {
        stream.on("event", handler);
      },
      finalResponse: async () => await stream.finalResponse(),
    };
  }

  private async createMultiAgentResponseStream(
    request: Record<string, unknown>,
    requestSignal: AbortSignal | undefined,
  ): Promise<OpenAIResponseStreamLike> {
    const streamingRequest = {
      ...request,
      stream: true,
    } as BetaResponseCreateParamsStreaming;
    const stream = await this.client.beta.responses.create(streamingRequest, {
      timeout: TASK_EXECUTION_TIMEOUT_MS,
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
    let eventHandler: ((event: OpenAIStreamEvent) => void) | undefined;

    return {
      abort: () => stream.controller.abort(),
      on: (_eventName, handler) => {
        eventHandler = handler;
      },
      finalResponse: async (): Promise<BetaResponse> => {
        let completedResponse: BetaResponse | undefined;

        for await (const event of stream) {
          eventHandler?.(event);

          if (event.type === "response.completed") {
            completedResponse = event.response;
          }
        }

        if (!completedResponse) {
          throw new Error(
            "The OpenAI multi-agent response stream ended before completion.",
          );
        }

        return completedResponse;
      },
    };
  }

  private normalizeResponse(response: OpenAIResponseLike): AgentModelTurn {
    const toolCalls: AgentModelToolCall[] = [];

    for (const outputItem of response.output ?? []) {
      if (outputItem.type !== "function_call") {
        continue;
      }

      let parsedArguments: Record<string, unknown> = {};

      if (typeof outputItem.arguments === "string") {
        try {
          const parsed = JSON.parse(outputItem.arguments) as unknown;

          if (typeof parsed === "object" && parsed !== null) {
            parsedArguments = parsed as Record<string, unknown>;
          }
        } catch {
          parsedArguments = {};
        }
      }

      toolCalls.push({
        id:
          typeof outputItem.call_id === "string" &&
          outputItem.call_id.length > 0
            ? outputItem.call_id
            : crypto.randomUUID(),
        name: outputItem.name ?? "unknown_tool",
        arguments: parsedArguments,
        ...(typeof outputItem.arguments === "string"
          ? { rawArguments: outputItem.arguments }
          : {}),
      });
    }

    return {
      text: getOpenAIResponseText(response),
      toolCalls,
    };
  }
}
