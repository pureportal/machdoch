import Anthropic from "@anthropic-ai/sdk";
import type {
  Message as AnthropicMessage,
  MessageParam as AnthropicMessageParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages";
import {
  createFunctionResponsePartFromBase64,
  createPartFromFunctionResponse,
  FunctionCallingConfigMode,
  GoogleGenAI,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import OpenAI from "openai";
import { hasConfiguredValue, loadWorkspaceEnv } from "../env.js";
import { TASK_EXECUTION_TIMEOUT_MS } from "./agent-runtime-types.js";
import type {
  AgentModelImageInput,
  AgentModelAdapter,
  AgentModelContinueParams,
  AgentModelStartParams,
  AgentModelToolCall,
  AgentModelToolResult,
  AgentModelToolResultContent,
  AgentModelToolSpec,
  AgentModelTurn,
  RuntimeConfig,
} from "../types.js";

const isSchemaRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const schemaAllowsNull = (schema: Record<string, unknown>): boolean => {
  if (schema.const === null) {
    return true;
  }

  if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
    return true;
  }

  if (schema.type === "null") {
    return true;
  }

  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];

    if (
      Array.isArray(options) &&
      options.some(
        (option) => isSchemaRecord(option) && schemaAllowsNull(option),
      )
    ) {
      return true;
    }
  }

  return false;
};

const makeSchemaNullable = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  if (schemaAllowsNull(schema)) {
    return schema;
  }

  const nullableSchema: Record<string, unknown> = { ...schema };

  if (
    Array.isArray(nullableSchema.enum) &&
    !nullableSchema.enum.includes(null)
  ) {
    nullableSchema.enum = [...nullableSchema.enum, null];
  }

  if (typeof nullableSchema.type === "string") {
    nullableSchema.type = [nullableSchema.type, "null"];
    return nullableSchema;
  }

  if (Array.isArray(nullableSchema.type)) {
    nullableSchema.type = nullableSchema.type.includes("null")
      ? nullableSchema.type
      : [...nullableSchema.type, "null"];
    return nullableSchema;
  }

  if (Array.isArray(nullableSchema.anyOf)) {
    nullableSchema.anyOf = [...nullableSchema.anyOf, { type: "null" }];
    return nullableSchema;
  }

  if (Array.isArray(nullableSchema.oneOf)) {
    nullableSchema.oneOf = [...nullableSchema.oneOf, { type: "null" }];
    return nullableSchema;
  }

  return {
    anyOf: [nullableSchema, { type: "null" }],
  };
};

export const normalizeOpenAIStrictInputSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const normalizedSchema: Record<string, unknown> = { ...schema };

  if (Array.isArray(schema.items)) {
    normalizedSchema.items = schema.items.map((item) =>
      isSchemaRecord(item) ? normalizeOpenAIStrictInputSchema(item) : item,
    );
  } else if (isSchemaRecord(schema.items)) {
    normalizedSchema.items = normalizeOpenAIStrictInputSchema(schema.items);
  }

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = schema[key];

    if (Array.isArray(variants)) {
      normalizedSchema[key] = variants.map((variant) =>
        isSchemaRecord(variant)
          ? normalizeOpenAIStrictInputSchema(variant)
          : variant,
      );
    }
  }

  if (isSchemaRecord(schema.not)) {
    normalizedSchema.not = normalizeOpenAIStrictInputSchema(schema.not);
  }

  const properties = isSchemaRecord(schema.properties)
    ? schema.properties
    : null;

  if (!properties) {
    if (schema.type === "object") {
      normalizedSchema.required = [];
    }

    return normalizedSchema;
  }

  const originalRequired = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );
  const normalizedProperties = Object.fromEntries(
    Object.entries(properties).map(([propertyName, propertySchema]) => {
      if (!isSchemaRecord(propertySchema)) {
        return [propertyName, propertySchema];
      }

      const normalizedPropertySchema =
        normalizeOpenAIStrictInputSchema(propertySchema);

      return [
        propertyName,
        originalRequired.has(propertyName)
          ? normalizedPropertySchema
          : makeSchemaNullable(normalizedPropertySchema),
      ];
    }),
  );

  normalizedSchema.properties = normalizedProperties;
  normalizedSchema.required = Object.keys(normalizedProperties);

  return normalizedSchema;
};

const createOpenAITools = (tools: AgentModelToolSpec[]) => {
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

export const createAnthropicToolSelection = () => ({
  tool_choice: {
    type: "any" as const,
    disable_parallel_tool_use: true,
  },
});

const hasImageInputs = (
  imageInputs: AgentModelImageInput[] | undefined,
): imageInputs is AgentModelImageInput[] => {
  return Array.isArray(imageInputs) && imageInputs.length > 0;
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

export const createProviderRequestSignal = (
  sourceSignal: AbortSignal | undefined,
): {
  signal?: AbortSignal;
  cleanup: () => void;
} => {
  if (!sourceSignal) {
    return {
      cleanup: (): void => {},
    };
  }

  const abortController = new AbortController();
  const forwardAbort = (): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(sourceSignal.reason);
    }
  };

  if (sourceSignal.aborted) {
    forwardAbort();

    return {
      signal: abortController.signal,
      cleanup: (): void => {},
    };
  }

  sourceSignal.addEventListener("abort", forwardAbort, { once: true });

  return {
    signal: abortController.signal,
    cleanup: (): void => {
      sourceSignal.removeEventListener("abort", forwardAbort);
    },
  };
};

const withProviderRequestSignal = async <T>(
  sourceSignal: AbortSignal | undefined,
  execute: (requestSignal: AbortSignal | undefined) => Promise<T>,
): Promise<T> => {
  const requestSignal = createProviderRequestSignal(sourceSignal);

  try {
    return await execute(requestSignal.signal);
  } finally {
    requestSignal.cleanup();
  }
};

const normalizeToolResultContent = (
  toolResult: AgentModelToolResult,
): AgentModelToolResultContent[] => {
  const normalized: AgentModelToolResultContent[] = [];

  for (const contentPart of toolResult.content ?? []) {
    if (contentPart.type === "text") {
      const text = contentPart.text.trim();

      if (text.length > 0) {
        normalized.push({
          type: "text",
          text,
        });
      }

      continue;
    }

    if (contentPart.data.trim().length > 0) {
      normalized.push(contentPart);
    }
  }

  const normalizedOutput = toolResult.output.trim();
  const hasTextContent = normalized.some(
    (contentPart) => contentPart.type === "text",
  );

  if (!hasTextContent && normalizedOutput.length > 0) {
    normalized.unshift({
      type: "text",
      text: normalizedOutput,
    });
  }

  if (normalized.length > 0) {
    return normalized;
  }

  return normalizedOutput.length > 0
    ? [
        {
          type: "text",
          text: normalizedOutput,
        },
      ]
    : [];
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

    const response = await withProviderRequestSignal(
      params.signal,
      async (requestSignal) =>
        this.client.responses.create({
          model: params.model,
          instructions: params.systemPrompt,
          input: createOpenAIUserInput(params),
          tools: createOpenAITools(params.tools),
          ...createOpenAIResponseToolSelection(),
        }, {
          timeout: TASK_EXECUTION_TIMEOUT_MS,
          ...(requestSignal ? { signal: requestSignal } : {}),
        }),
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
    const response = await withProviderRequestSignal(
      params.signal,
      async (requestSignal) =>
        this.client.responses.create({
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
        }, {
          timeout: TASK_EXECUTION_TIMEOUT_MS,
          ...(requestSignal ? { signal: requestSignal } : {}),
        }),
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
      content: createAnthropicUserContent(params),
    });

    const message = await withProviderRequestSignal(
      params.signal,
      async (requestSignal) =>
        this.client.messages.create({
          model: params.model,
          max_tokens: 4_096,
          system: params.systemPrompt,
          messages: this.messages,
          tools: createAnthropicTools(params.tools),
          ...createAnthropicToolSelection(),
        }, {
          timeout: TASK_EXECUTION_TIMEOUT_MS,
          ...(requestSignal ? { signal: requestSignal } : {}),
        }),
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

    const message = await withProviderRequestSignal(
      params.signal,
      async (requestSignal) =>
        this.client.messages.create({
          model: startParams.model,
          max_tokens: 4_096,
          system: startParams.systemPrompt,
          messages: this.messages,
          tools: createAnthropicTools(this.tools),
          ...createAnthropicToolSelection(),
        }, {
          timeout: TASK_EXECUTION_TIMEOUT_MS,
          ...(requestSignal ? { signal: requestSignal } : {}),
        }),
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

    const response = await withProviderRequestSignal(
      params.signal,
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
    const response = await withProviderRequestSignal(
      params.signal,
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

      if (!apiKey || !hasConfiguredValue(apiKey)) {
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
