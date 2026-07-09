import {
  createFunctionResponsePartFromBase64,
  createPartFromFunctionResponse,
  FunctionCallingConfigMode,
  type GenerateContentResponse,
  type GoogleGenAI,
  type Part,
  ThinkingLevel,
} from "@google/genai";
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
  normalizeGeminiUsage,
} from "./stream-events.js";
import { normalizeToolResultContent } from "./tool-result-content.js";

export const createGeminiUserMessage = (
  params: Pick<AgentModelStartParams, "imageInputs" | "userPrompt">,
): string | Part[] => {
  if (!hasImageInputs(params.imageInputs)) {
    return params.userPrompt;
  }

  return [
    ...params.imageInputs.map((imageInput) => ({
      inlineData: {
        data: imageInput.data,
        mimeType: imageInput.mediaType,
      },
    })),
    {
      text: params.userPrompt,
    },
  ];
};

export const createGeminiTools = (tools: AgentModelToolSpec[]) => {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.inputSchema,
      })),
    },
  ];
};

const isGemini25Model = (model: string): boolean => {
  return /\bgemini-2\.5\b/i.test(model);
};

const isGemini3Model = (model: string): boolean => {
  return /\bgemini-3(?:\.\d+)?\b/i.test(model);
};

const isGemini25ProModel = (model: string): boolean => {
  return /\bgemini-2\.5\b.*\bpro\b/i.test(model);
};

const isGemini3ProModel = (model: string): boolean => {
  return /\bgemini-3(?:\.\d+)?\b.*\bpro\b/i.test(model);
};

const mapReasoningToGeminiThinkingLevel = (
  model: string,
  reasoning: Exclude<ReasoningMode, "default">,
): ThinkingLevel => {
  if (reasoning === "none" || reasoning === "minimal") {
    return isGemini3ProModel(model) ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL;
  }

  if (
    reasoning === "xhigh" ||
    reasoning === "max" ||
    reasoning === "ultra"
  ) {
    return ThinkingLevel.HIGH;
  }

  return {
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH,
  }[reasoning];
};

const mapReasoningToGeminiThinkingBudget = (
  model: string,
  reasoning: Exclude<ReasoningMode, "default">,
): number => {
  switch (reasoning) {
    case "none":
      return isGemini25ProModel(model) ? 128 : 0;
    case "minimal":
      return isGemini25ProModel(model) ? 128 : 512;
    case "low":
      return 1_024;
    case "medium":
      return 4_096;
    case "high":
      return 8_192;
    case "xhigh":
      return 16_384;
    case "max":
      return 24_576;
    case "ultra":
      return 24_576;
  }
};

export const createGeminiThinkingConfig = (
  model: string,
  reasoning?: ReasoningMode,
): { thinkingConfig?: { thinkingLevel?: ThinkingLevel; thinkingBudget?: number } } => {
  if (!reasoning || reasoning === "default") {
    return {};
  }

  const normalizedReasoning = normalizeReasoningModeForProviderModel(
    reasoning,
    "google",
    model,
  );

  if (normalizedReasoning === "default") {
    return {};
  }

  if (isGemini25Model(model)) {
    return {
      thinkingConfig: {
        thinkingBudget: mapReasoningToGeminiThinkingBudget(
          model,
          normalizedReasoning,
        ),
      },
    };
  }

  return {
    thinkingConfig: {
      thinkingLevel: mapReasoningToGeminiThinkingLevel(
        model,
        normalizedReasoning,
      ),
    },
  };
};

export const createGeminiFunctionCallingMode = (
  model: string,
): FunctionCallingConfigMode => {
  return isGemini3Model(model)
    ? FunctionCallingConfigMode.VALIDATED
    : FunctionCallingConfigMode.ANY;
};

const createGeminiFunctionResponseParts = (
  toolResult: AgentModelToolResult,
) => {
  return normalizeToolResultContent(toolResult).flatMap((contentPart) => {
    if (contentPart.type !== "image") {
      return [];
    }

    return [
      createFunctionResponsePartFromBase64(
        contentPart.data,
        contentPart.mediaType,
      ),
    ];
  });
};

const createGeminiFunctionResponsePayload = (
  toolResult: AgentModelToolResult,
): Record<string, unknown> => {
  if (toolResult.isError) {
    return {
      error: toolResult.output,
    };
  }

  return {
    output: toolResult.output,
  };
};

type GeminiResponsePart = Pick<Part, "text" | "thought" | "functionCall">;
type GeminiResponseLike = {
  candidates?: GenerateContentResponse["candidates"] | undefined;
};

const extractGeminiResponseParts = (
  response: GeminiResponseLike,
): GeminiResponsePart[] => {
  const firstCandidate = response.candidates?.[0];

  if (!firstCandidate?.content || !Array.isArray(firstCandidate.content.parts)) {
    return [];
  }

  return firstCandidate.content.parts;
};

export const normalizeGeminiResponse = (
  response: GeminiResponseLike,
): AgentModelTurn => {
  let text = "";
  const toolCalls: AgentModelToolCall[] = [];

  for (const part of extractGeminiResponseParts(response)) {
    if (typeof part.text === "string" && part.thought !== true) {
      text += part.text;
    }

    const functionCall = part.functionCall;

    if (!functionCall) {
      continue;
    }

    toolCalls.push({
      id: functionCall.id ?? crypto.randomUUID(),
      name: functionCall.name ?? "unknown_tool",
      arguments:
        typeof functionCall.args === "object" && functionCall.args !== null
          ? (functionCall.args as Record<string, unknown>)
          : {},
    });
  }

  return {
    text: text.trim(),
    toolCalls,
  };
};

const isAgentModelTurn = (value: unknown): value is AgentModelTurn => {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AgentModelTurn).text === "string" &&
    Array.isArray((value as AgentModelTurn).toolCalls)
  );
};

export class GeminiChatAdapter implements AgentModelAdapter {
  private readonly chat: ReturnType<GoogleGenAI["chats"]["create"]>;
  private readonly tools: AgentModelToolSpec[];
  private readonly provider: ModelProvider;
  private startParams?: AgentModelStartParams;

  private createConfig(model: string, tools: AgentModelToolSpec[]) {
    if (tools.length === 0) {
      return {
        automaticFunctionCalling: {
          disable: true,
        },
      };
    }

    return {
      tools: createGeminiTools(tools),
      toolConfig: {
        functionCallingConfig: {
          mode: createGeminiFunctionCallingMode(model),
          allowedFunctionNames: tools.map((tool) => tool.name),
        },
      },
      automaticFunctionCalling: {
        disable: true,
      },
    };
  }

  constructor(
    client: GoogleGenAI,
    model: string,
    tools: AgentModelToolSpec[],
    provider: ModelProvider = "google",
  ) {
    this.tools = tools;
    this.provider = provider;
    this.chat = client.chats.create({
      model,
      config: this.createConfig(model, tools),
    });
  }

  async startTurn(params: AgentModelStartParams): Promise<AgentModelTurn> {
    this.startParams = params;

    const response = await withProviderRequest(
      {
        provider: this.provider,
        operation: "startTurn",
        signal: params.signal,
      },
      async (requestSignal) => {
        const request = {
          message: createGeminiUserMessage(params),
          config: {
            systemInstruction: params.systemPrompt,
            ...this.createConfig(params.model, params.tools),
            ...createGeminiThinkingConfig(params.model, params.reasoning),
            httpOptions: {
              timeout: TASK_EXECUTION_TIMEOUT_MS,
            },
            ...(requestSignal ? { abortSignal: requestSignal } : {}),
          },
        };

        if (params.onStreamEvent) {
          return await this.sendStreamingMessage(
            request,
            params.onStreamEvent,
          );
        }

        return await this.chat.sendMessage(request);
      },
    );

    return isAgentModelTurn(response) ? response : this.normalizeResponse(response);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams) {
      throw new Error("The Gemini adapter cannot continue before it starts.");
    }

    const startParams = this.startParams;

    emitToolResultStreamEvents(
      params.onStreamEvent,
      this.provider,
      params.toolResults,
    );

    const response = await withProviderRequest(
      {
        provider: this.provider,
        operation: "continueTurn",
        signal: params.signal,
      },
      async (requestSignal) => {
        const request = {
          message: params.toolResults.map((toolResult) =>
            createPartFromFunctionResponse(
              toolResult.callId,
              toolResult.name,
              createGeminiFunctionResponsePayload(toolResult),
              createGeminiFunctionResponseParts(toolResult),
            ),
          ),
          config: {
            systemInstruction: startParams.systemPrompt,
            ...this.createConfig(startParams.model, this.tools),
            ...createGeminiThinkingConfig(
              startParams.model,
              startParams.reasoning,
            ),
            httpOptions: {
              timeout: TASK_EXECUTION_TIMEOUT_MS,
            },
            ...(requestSignal ? { abortSignal: requestSignal } : {}),
          },
        };

        if (params.onStreamEvent) {
          return await this.sendStreamingMessage(
            request,
            params.onStreamEvent,
          );
        }

        return await this.chat.sendMessage(request);
      },
    );

    return isAgentModelTurn(response) ? response : this.normalizeResponse(response);
  }

  private normalizeResponse(response: {
    candidates?: GenerateContentResponse["candidates"];
  }): AgentModelTurn {
    return normalizeGeminiResponse(response);
  }

  private async sendStreamingMessage(
    request: Parameters<typeof this.chat.sendMessage>[0],
    onStreamEvent: AgentModelStreamEventHandler,
  ): Promise<AgentModelTurn> {
    emitProviderStreamStatus(
      onStreamEvent,
      this.provider,
      "starting",
      "Gemini content stream started.",
    );

    const stream = await this.chat.sendMessageStream(request);
    let text = "";
    let didEmitInProgress = false;
    const toolCallsByKey = new Map<string, AgentModelToolCall>();

    try {
      for await (const chunk of stream) {
        if (!didEmitInProgress) {
          didEmitInProgress = true;
          emitProviderStreamStatus(
            onStreamEvent,
            this.provider,
            "in-progress",
            "Gemini content stream in progress.",
          );
        }

        emitUsageStreamEvent(
          onStreamEvent,
          this.provider,
          normalizeGeminiUsage(
            (chunk as { usageMetadata?: unknown }).usageMetadata,
          ),
        );

        for (const part of extractGeminiResponseParts(chunk)) {
          if (typeof part.text === "string" && part.thought === true) {
            emitProviderStreamEvent(onStreamEvent, {
              type: "reasoning-delta",
              provider: this.provider,
              delta: part.text,
            });
            continue;
          }

          if (typeof part.text === "string") {
            text += part.text;
            emitProviderStreamEvent(onStreamEvent, {
              type: "text-delta",
              provider: this.provider,
              delta: part.text,
            });
          }

          const functionCall = part.functionCall;

          if (!functionCall) {
            continue;
          }

          const name = functionCall.name ?? "unknown_tool";
          const id = functionCall.id ?? crypto.randomUUID();
          const key = functionCall.id ?? `${name}:${toolCallsByKey.size}`;
          const parsedArguments =
            typeof functionCall.args === "object" && functionCall.args !== null
              ? (functionCall.args as Record<string, unknown>)
              : {};
          const rawArguments = JSON.stringify(parsedArguments);

          if (!toolCallsByKey.has(key)) {
            emitProviderStreamEvent(onStreamEvent, {
              type: "tool-call-start",
              provider: this.provider,
              id,
              name,
            });
          }

          emitProviderStreamEvent(onStreamEvent, {
            type: "tool-call-done",
            provider: this.provider,
            id,
            name,
            argumentsText: rawArguments,
          });
          toolCallsByKey.set(key, {
            id,
            name,
            arguments: parsedArguments,
            rawArguments,
          });
        }
      }
    } catch (error) {
      emitProviderStreamError(onStreamEvent, this.provider, error);
      throw error;
    }

    emitProviderStreamStatus(
      onStreamEvent,
      this.provider,
      "completed",
      "Gemini content stream completed.",
    );

    return {
      text: text.trim(),
      toolCalls: [...toolCallsByKey.values()],
    };
  }
}
