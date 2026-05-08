import type OpenAI from "openai";
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
import { normalizeOpenAIStrictInputSchema } from "./schema-normalization.js";
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
      async (requestSignal) =>
        this.client.responses.create(
          {
            model: params.model,
            instructions: params.systemPrompt,
            input: createOpenAIUserInput(params),
            tools: createOpenAITools(params.tools),
            ...createOpenAIResponseToolSelection(),
          },
          {
            timeout: TASK_EXECUTION_TIMEOUT_MS,
            ...(requestSignal ? { signal: requestSignal } : {}),
          },
        ),
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
    const response = await withProviderRequest(
      {
        provider: "openai",
        operation: "continueTurn",
        signal: params.signal,
      },
      async (requestSignal) =>
        this.client.responses.create(
          {
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
          },
          {
            timeout: TASK_EXECUTION_TIMEOUT_MS,
            ...(requestSignal ? { signal: requestSignal } : {}),
          },
        ),
    );

    this.previousResponseId = response.id;
    return this.normalizeResponse(response);
  }

  private normalizeResponse(response: {
    output?: Array<{
      type?: string;
      name?: string;
      arguments?: unknown;
      call_id?: string | null;
    }>;
    output_text?: string | undefined;
  }): AgentModelTurn {
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
