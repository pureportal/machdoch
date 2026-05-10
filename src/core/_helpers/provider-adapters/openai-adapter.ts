import type OpenAI from "openai";
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
    parameters: normalizeOpenAIStrictInputSchema(tool.inputSchema),
    strict: true,
  }));
};

export const createOpenAIResponseToolSelection = () => ({
  parallel_tool_calls: false,
  tool_choice: "required" as const,
});

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

type OpenAIResponseLike = {
  id: string;
  usage?: unknown;
  output?: Array<{
    type?: string;
    name?: string;
    arguments?: unknown;
    call_id?: string | null;
  }>;
  output_text?: string | undefined;
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
          ...createOpenAIResponseToolSelection(),
        };

        if (params.onStreamEvent) {
          return await this.createStreamingResponse(
            request,
            requestSignal,
            params.onStreamEvent,
          );
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
          ...createOpenAIResponseToolSelection(),
        };

        if (params.onStreamEvent) {
          return await this.createStreamingResponse(
            request,
            requestSignal,
            params.onStreamEvent,
          );
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

    const stream = this.client.responses.stream(
      {
        ...request,
        stream: true,
      },
      {
        timeout: TASK_EXECUTION_TIMEOUT_MS,
        ...(requestSignal ? { signal: requestSignal } : {}),
      },
    );
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
      stream.on("event", (event: ResponseStreamEvent) => {
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

        if (event.type.includes("reasoning")) {
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
      text: response.output_text?.trim() ?? "",
      toolCalls,
    };
  }
}
