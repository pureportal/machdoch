import {
  createFunctionResponsePartFromBase64,
  createPartFromFunctionResponse,
  FunctionCallingConfigMode,
  type GenerateContentResponse,
  type GoogleGenAI,
  type Part,
} from "@google/genai";
import type {
  AgentModelAdapter,
  AgentModelContinueParams,
  AgentModelStartParams,
  AgentModelToolCall,
  AgentModelToolResult,
  AgentModelToolSpec,
  AgentModelTurn,
} from "../../types.js";
import { TASK_EXECUTION_TIMEOUT_MS } from "../agent-runtime-types.js";
import { hasImageInputs } from "./image-inputs.js";
import { withProviderRequest } from "./request.js";
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

export class GeminiChatAdapter implements AgentModelAdapter {
  private readonly chat: ReturnType<GoogleGenAI["chats"]["create"]>;
  private readonly tools: AgentModelToolSpec[];
  private startParams?: AgentModelStartParams;

  private createConfig(tools: AgentModelToolSpec[]) {
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
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: tools.map((tool) => tool.name),
        },
      },
      automaticFunctionCalling: {
        disable: true,
      },
    };
  }

  constructor(client: GoogleGenAI, model: string, tools: AgentModelToolSpec[]) {
    this.tools = tools;
    this.chat = client.chats.create({
      model,
      config: this.createConfig(tools),
    });
  }

  async startTurn(params: AgentModelStartParams): Promise<AgentModelTurn> {
    this.startParams = params;

    const response = await withProviderRequest(
      {
        provider: "google",
        operation: "startTurn",
        signal: params.signal,
      },
      async (requestSignal) =>
        this.chat.sendMessage({
          message: createGeminiUserMessage(params),
          config: {
            systemInstruction: params.systemPrompt,
            ...this.createConfig(params.tools),
            httpOptions: {
              timeout: TASK_EXECUTION_TIMEOUT_MS,
            },
            ...(requestSignal ? { abortSignal: requestSignal } : {}),
          },
        }),
    );

    return this.normalizeResponse(response);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams) {
      throw new Error("The Gemini adapter cannot continue before it starts.");
    }

    const startParams = this.startParams;
    const response = await withProviderRequest(
      {
        provider: "google",
        operation: "continueTurn",
        signal: params.signal,
      },
      async (requestSignal) =>
        this.chat.sendMessage({
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
            ...this.createConfig(this.tools),
            httpOptions: {
              timeout: TASK_EXECUTION_TIMEOUT_MS,
            },
            ...(requestSignal ? { abortSignal: requestSignal } : {}),
          },
        }),
    );

    return this.normalizeResponse(response);
  }

  private normalizeResponse(response: {
    candidates?: GenerateContentResponse["candidates"];
  }): AgentModelTurn {
    return normalizeGeminiResponse(response);
  }
}
