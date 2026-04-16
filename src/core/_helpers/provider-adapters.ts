import Anthropic from "@anthropic-ai/sdk";
import type {
  Message as AnthropicMessage,
  MessageParam as AnthropicMessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages";
import {
  createPartFromFunctionResponse,
  FunctionCallingConfigMode,
  GoogleGenAI,
} from "@google/genai";
import OpenAI from "openai";
import { hasConfiguredValue, loadWorkspaceEnv } from "../env.js";
import type {
  AgentModelAdapter,
  AgentModelContinueParams,
  AgentModelStartParams,
  AgentModelToolCall,
  AgentModelToolSpec,
  AgentModelTurn,
  RuntimeConfig,
} from "../types.js";

const createOpenAITools = (tools: AgentModelToolSpec[]) => {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true,
  }));
};

const createAnthropicTools = (tools: AgentModelToolSpec[]): AnthropicTool[] => {
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

const createGeminiTools = (tools: AgentModelToolSpec[]) => {
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

class OpenAIResponsesAdapter implements AgentModelAdapter {
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

    const response = await this.client.responses.create({
      model: params.model,
      instructions: params.systemPrompt,
      input: params.userPrompt,
      tools: createOpenAITools(params.tools),
      parallel_tool_calls: false,
    });

    this.previousResponseId = response.id;
    return this.normalizeResponse(response);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams || !this.previousResponseId) {
      throw new Error("The OpenAI adapter cannot continue before it starts.");
    }

    const response = await this.client.responses.create({
      model: this.startParams.model,
      instructions: this.startParams.systemPrompt,
      previous_response_id: this.previousResponseId,
      input: params.toolResults.map((toolResult) => ({
        type: "function_call_output" as const,
        call_id: toolResult.callId,
        output: toolResult.output,
      })),
      tools: createOpenAITools(this.tools),
      parallel_tool_calls: false,
    });

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

class AnthropicMessagesAdapter implements AgentModelAdapter {
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
      content: params.userPrompt,
    });

    const message = await this.client.messages.create({
      model: params.model,
      max_tokens: 4_096,
      system: params.systemPrompt,
      messages: this.messages,
      tools: createAnthropicTools(params.tools),
    });

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

    this.messages.push({
      role: "user",
      content: params.toolResults.map((toolResult) => ({
        type: "tool_result" as const,
        tool_use_id: toolResult.callId,
        content: toolResult.output,
        ...(toolResult.isError ? { is_error: true } : {}),
      })) as AnthropicMessageParam["content"],
    });

    const message = await this.client.messages.create({
      model: this.startParams.model,
      max_tokens: 4_096,
      system: this.startParams.systemPrompt,
      messages: this.messages,
      tools: createAnthropicTools(this.tools),
    });

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

class GeminiChatAdapter implements AgentModelAdapter {
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

    const response = await this.chat.sendMessage({
      message: params.userPrompt,
      config: {
        systemInstruction: params.systemPrompt,
        ...this.createConfig(params.tools),
      },
    });

    return this.normalizeResponse(response);
  }

  async continueTurn(
    params: AgentModelContinueParams,
  ): Promise<AgentModelTurn> {
    if (!this.startParams) {
      throw new Error("The Gemini adapter cannot continue before it starts.");
    }

    const response = await this.chat.sendMessage({
      message: params.toolResults.map((toolResult) =>
        createPartFromFunctionResponse(toolResult.callId, toolResult.name, {
          output: toolResult.output,
          isError: toolResult.isError === true,
        }),
      ),
      config: {
        systemInstruction: this.startParams.systemPrompt,
        ...this.createConfig(this.tools),
      },
    });

    return this.normalizeResponse(response);
  }

  private normalizeResponse(response: {
    text?: string | undefined;
    functionCalls?:
      | Array<{
          id?: string | undefined;
          name?: string | undefined;
          args?: Record<string, unknown> | undefined;
        }>
      | undefined;
  }): AgentModelTurn {
    return {
      text: response.text?.trim() ?? "",
      toolCalls: (response.functionCalls ?? []).map((functionCall) => ({
        id: functionCall.id ?? crypto.randomUUID(),
        name: functionCall.name ?? "unknown_tool",
        arguments: functionCall.args ?? {},
      })),
    };
  }
}

export const createProviderAdapter = async (
  config: RuntimeConfig,
  tools: AgentModelToolSpec[],
  overrideAdapter: AgentModelAdapter | undefined,
): Promise<AgentModelAdapter | undefined> => {
  if (overrideAdapter) {
    return overrideAdapter;
  }

  if (config.provider === "unconfigured" || config.offline) {
    return undefined;
  }

  const env = await loadWorkspaceEnv(config.workspaceRoot);

  switch (config.provider) {
    case "openai": {
      if (!hasConfiguredValue(env.OPENAI_API_KEY)) {
        return undefined;
      }

      return new OpenAIResponsesAdapter(
        new OpenAI({
          apiKey: env.OPENAI_API_KEY,
        }),
        tools,
      );
    }

    case "anthropic": {
      if (!hasConfiguredValue(env.ANTHROPIC_API_KEY)) {
        return undefined;
      }

      return new AnthropicMessagesAdapter(
        new Anthropic({
          apiKey: env.ANTHROPIC_API_KEY,
        }),
        tools,
      );
    }

    case "google": {
      const apiKey = env.GOOGLE_API_KEY;

      if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
        return undefined;
      }

      return new GeminiChatAdapter(
        new GoogleGenAI({ apiKey }),
        config.model,
        tools,
      );
    }
  }
};
