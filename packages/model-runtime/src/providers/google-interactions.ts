import type { GoogleGenAI, Interactions } from "@google/genai";
import type {
  AgentModelAdapter,
  AgentModelContinueParams,
  AgentModelStartParams,
  AgentModelStreamUsage,
  AgentModelTurn,
} from "../types.ts";
import { assertReasoningModeSupportedForProviderModel } from "../reasoning-modes.ts";
import { decodeToolArguments } from "./tool-arguments.ts";
import { normalizeToolResultContent } from "./tool-result-content.ts";
import {
  emitProviderStreamEvent,
  emitProviderStreamStatus,
  emitToolResultStreamEvents,
  emitUsageStreamEvent,
} from "./stream-events.ts";
import { withProviderRequest } from "./request.ts";

type GoogleInteraction = Awaited<
  ReturnType<GoogleGenAI["interactions"]["create"]>
>;
type InteractionReply = Pick<
  Interactions.Interaction,
  "id" | "status" | "steps" | "usage"
>;

export function normalizeInteractionUsage(
  usage: Interactions.Interaction["usage"],
): AgentModelStreamUsage | undefined {
  if (!usage) return undefined;
  const normalized: AgentModelStreamUsage = {};
  for (const [source, target] of [
    ["total_input_tokens", "inputTokens"],
    ["total_output_tokens", "outputTokens"],
    ["total_tokens", "totalTokens"],
    ["total_cached_tokens", "cachedInputTokens"],
    ["total_thought_tokens", "reasoningTokens"],
    ["total_tool_use_tokens", "toolUseInputTokens"],
  ] as const) {
    const value = usage[source];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      normalized[target] = value;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

export function normalizeGoogleInteraction(
  reply: InteractionReply,
): AgentModelTurn {
  if (!["completed", "requires_action", "incomplete"].includes(reply.status))
    throw new Error(`Google interaction ended with status ${reply.status}.`);
  const text = (reply.steps ?? [])
    .flatMap((step) =>
      step.type === "model_output"
        ? (step.content ?? []).flatMap((content) =>
            content.type === "text" ? [content.text ?? ""] : [],
          )
        : [],
    )
    .join("");
  const toolCalls = (reply.steps ?? []).flatMap((step) =>
    step.type === "function_call"
      ? [
          {
            id: step.id,
            name: step.name,
            ...decodeToolArguments(step.arguments),
          },
        ]
      : [],
  );
  const usage = normalizeInteractionUsage(reply.usage);
  return {
    text: text.trim(),
    toolCalls,
    stopReason: reply.status,
    ...(usage ? { usage } : {}),
  };
}

export class GoogleInteractionsAdapter implements AgentModelAdapter {
  private params: AgentModelStartParams | undefined;
  private history: Interactions.Step[] = [];
  constructor(private readonly client: GoogleGenAI) {}

  async startTurn(params: AgentModelStartParams): Promise<AgentModelTurn> {
    this.params = params;
    this.history = [];
    const input: Interactions.Step[] = [
      {
        type: "user_input",
        content: [
          ...(params.imageInputs ?? []).map(
            (image): Interactions.Content => ({
              type: "image",
              data: image.data,
              mime_type: image.mediaType,
            }),
          ),
          { type: "text", text: params.userPrompt },
        ],
      },
    ];
    return this.request(params, input, "startTurn");
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.params || !this.history.length)
      throw new Error(
        "The Google interaction must start before it can continue.",
      );
    emitToolResultStreamEvents(
      params.onStreamEvent,
      "google",
      params.toolResults,
    );
    const results: Interactions.Step[] = params.toolResults.map((result) => ({
      type: "function_result",
      call_id: result.callId,
      name: result.name,
      is_error: result.isError ?? false,
      result: normalizeToolResultContent(result).map((content) =>
        content.type === "image"
          ? {
              type: "image" as const,
              data: content.data,
              mime_type: content.mediaType,
            }
          : { type: "text" as const, text: content.text },
      ),
    }));
    const {
      onStreamEvent: _stream,
      onRequestAttempt: _attempt,
      signal: _signal,
      ...base
    } = this.params;
    return this.request(
      { ...base, ...params },
      [...this.history, ...results],
      "continueTurn",
    );
  }

  private async request(
    params: AgentModelStartParams,
    input: Interactions.Step[],
    operation: string,
  ): Promise<AgentModelTurn> {
    const generation: Interactions.GenerationConfig = {
      tool_choice: params.tools.length
        ? params.toolChoice === "required"
          ? "any"
          : "auto"
        : "none",
      ...(params.maxOutputTokens !== undefined
        ? { max_output_tokens: params.maxOutputTokens }
        : {}),
    };
    if (params.reasoning && params.reasoning !== "default") {
      assertReasoningModeSupportedForProviderModel(
        params.reasoning,
        "google",
        params.model,
      );
      if (!["minimal", "low", "medium", "high"].includes(params.reasoning))
        throw new Error(
          `Unsupported Google thinking level: ${params.reasoning}.`,
        );
      generation.thinking_level = params.reasoning as
        | "minimal"
        | "low"
        | "medium"
        | "high";
    }
    if (
      params.structuredOutput &&
      (typeof params.structuredOutput.schema !== "object" ||
        params.structuredOutput.schema === null ||
        Array.isArray(params.structuredOutput.schema))
    )
      throw new Error("Structured output requires a JSON object schema.");
    const request = {
      api_version: "v1",
      model: params.model,
      input,
      system_instruction: params.systemPrompt,
      store: false,
      background: false,
      tools: params.tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
      generation_config: generation,
      ...(params.structuredOutput
        ? {
            response_format: {
              type: "text" as const,
              mime_type: "application/json" as const,
              schema: params.structuredOutput.schema as Record<string, unknown>,
            },
          }
        : {}),
    };
    const response = await withProviderRequest(
      {
        provider: "google",
        operation,
        signal: params.signal,
        maxAttempts: params.maxRequestAttempts ?? 3,
        ...(params.onRequestAttempt ? { logger: params.onRequestAttempt } : {}),
      },
      async (signal) => {
        const options = { ...(signal ? { signal } : {}), maxRetries: 0 };
        if (!params.onStreamEvent)
          return this.client.interactions.create(
            { ...request, stream: false },
            options,
          );
        emitProviderStreamStatus(
          params.onStreamEvent,
          "google",
          "starting",
          "Google interaction started.",
        );
        const stream = await this.client.interactions.create(
          { ...request, stream: true },
          options,
        );
        return this.collect(stream, params);
      },
    );
    const result = normalizeGoogleInteraction(response);
    this.history = [...input, ...(response.steps ?? [])];
    return result;
  }

  private async collect(
    stream: Extract<GoogleInteraction, AsyncIterable<unknown>>,
    params: AgentModelStartParams,
  ): Promise<InteractionReply> {
    const steps = new Map<number, Interactions.Step>();
    const argumentsByStep = new Map<number, string>();
    let reply: InteractionReply | undefined;
    let complete = false;
    for await (const event of stream) {
      params.signal?.throwIfAborted();
      switch (event.event_type) {
        case "interaction.created":
          if (reply && reply.id !== event.interaction.id)
            throw new Error("Google stream changed interaction identity.");
          reply = event.interaction;
          break;
        case "interaction.completed":
          if (reply && reply.id !== event.interaction.id)
            throw new Error("Google stream changed interaction identity.");
          reply = event.interaction;
          complete = true;
          break;
        case "interaction.status_update":
          if (reply && reply.id !== event.interaction_id)
            throw new Error("Google stream changed interaction identity.");
          if (reply) reply = { ...reply, status: event.status };
          if (event.status === "requires_action") complete = true;
          if (["failed", "cancelled", "budget_exceeded"].includes(event.status))
            throw new Error(
              `Google interaction ended with status ${event.status}.`,
            );
          break;
        case "error":
          throw new Error("Google interaction stream reported an error.");
        case "step.start":
          if (steps.has(event.index))
            throw new Error("Google interaction repeated a step index.");
          steps.set(event.index, structuredClone(event.step));
          if (event.step.type === "function_call")
            emitProviderStreamEvent(params.onStreamEvent, {
              type: "tool-call-start",
              provider: "google",
              id: event.step.id,
              name: event.step.name,
            });
          break;
        case "step.delta": {
          const step = steps.get(event.index);
          if (!step)
            throw new Error(
              "Google interaction delta has no corresponding step.",
            );
          if (event.delta.type === "text" && step.type === "model_output") {
            const parts = step.content ?? (step.content = []);
            const last = parts.at(-1);
            if (last?.type === "text")
              last.text = (last.text ?? "") + event.delta.text;
            else parts.push({ type: "text", text: event.delta.text });
            emitProviderStreamEvent(params.onStreamEvent, {
              type: "text-delta",
              provider: "google",
              delta: event.delta.text,
            });
          } else if (
            event.delta.type === "arguments_delta" &&
            step.type === "function_call"
          ) {
            const text =
              (argumentsByStep.get(event.index) ?? "") +
              (event.delta.arguments ?? "");
            argumentsByStep.set(event.index, text);
            emitProviderStreamEvent(params.onStreamEvent, {
              type: "tool-call-arguments-delta",
              provider: "google",
              id: step.id,
              name: step.name,
              delta: event.delta.arguments ?? "",
            });
          } else if (
            event.delta.type === "thought_signature" &&
            step.type === "thought"
          )
            step.signature =
              (step.signature ?? "") + (event.delta.signature ?? "");
          else if (
            event.delta.type === "thought_summary" &&
            step.type === "thought" &&
            event.delta.content
          ) {
            if (
              event.delta.content.type === "text" ||
              event.delta.content.type === "image"
            )
              (step.summary ?? (step.summary = [])).push(event.delta.content);
            if (event.delta.content.type === "text")
              emitProviderStreamEvent(params.onStreamEvent, {
                type: "reasoning-delta",
                provider: "google",
                delta: event.delta.content.text ?? "",
              });
          }
          break;
        }
        case "step.stop": {
          const step = steps.get(event.index);
          if (step?.type === "function_call") {
            const encoded = argumentsByStep.get(event.index);
            if (encoded !== undefined) {
              const decoded = decodeToolArguments(encoded, true);
              if (decoded.argumentError)
                throw new Error(
                  "Google returned malformed function arguments.",
                );
              step.arguments = decoded.arguments;
            }
            emitProviderStreamEvent(params.onStreamEvent, {
              type: "tool-call-done",
              provider: "google",
              id: step.id,
              name: step.name,
              argumentsText: JSON.stringify(step.arguments),
            });
          }
          break;
        }
      }
    }
    if (!complete || !reply)
      throw new Error(
        "Google interaction stream ended without a terminal event.",
      );
    const result = {
      ...reply,
      steps:
        reply.steps ??
        [...steps.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, step]) => step),
    };
    emitUsageStreamEvent(
      params.onStreamEvent,
      "google",
      normalizeInteractionUsage(reply.usage),
    );
    emitProviderStreamStatus(
      params.onStreamEvent,
      "google",
      "completed",
      "Google interaction completed.",
    );
    return result;
  }
}
