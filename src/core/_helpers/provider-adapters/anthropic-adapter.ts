import type Anthropic from "@anthropic-ai/sdk";
import type {
  Message as AnthropicMessage,
  MessageParam as AnthropicMessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages";
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

export const createAnthropicToolSelection = () => ({
  tool_choice: {
    type: "any" as const,
    disable_parallel_tool_use: true,
  },
});

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
  private readonly messages: AnthropicMessageParam[] = [];
  private startParams?: AgentModelStartParams;

  constructor(client: Anthropic, tools: AgentModelToolSpec[]) {
    this.client = client;
    this.tools = tools;
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
        provider: "anthropic",
        operation: "startTurn",
        signal: params.signal,
      },
      async (requestSignal) =>
        this.client.messages.create(
          {
            model: params.model,
            max_tokens: 4_096,
            system: params.systemPrompt,
            messages: [...this.messages],
            tools: createAnthropicTools(params.tools),
            ...createAnthropicToolSelection(),
          },
          {
            timeout: TASK_EXECUTION_TIMEOUT_MS,
            ...(requestSignal ? { signal: requestSignal } : {}),
          },
        ),
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

    const message = await withProviderRequest(
      {
        provider: "anthropic",
        operation: "continueTurn",
        signal: params.signal,
      },
      async (requestSignal) =>
        this.client.messages.create(
          {
            model: startParams.model,
            max_tokens: 4_096,
            system: startParams.systemPrompt,
            messages: [...this.messages],
            tools: createAnthropicTools(this.tools),
            ...createAnthropicToolSelection(),
          },
          {
            timeout: TASK_EXECUTION_TIMEOUT_MS,
            ...(requestSignal ? { signal: requestSignal } : {}),
          },
        ),
    );

    this.messages.push({
      role: "assistant",
      content: message.content as AnthropicMessageParam["content"],
    });

    return this.normalizeResponse(message);
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
