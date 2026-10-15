import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import { expect, it, vi } from "vitest";
import type { AgentModelAdapter, AgentModelToolSpec } from "../../types.js";
import { runtimeConfig } from "../../__test__/ralph-test-helpers.js";
import { executeToolCall } from "../agent-tools.js";
import { validateToolArguments } from "../tool-argument-validation.js";
import { createFilesystemToolDefinitions } from "../filesystem-tool-definitions.js";
import { OpenAIResponsesAdapter } from "./openai-adapter.js";
import { LangdockChatCompletionsAdapter } from "./langdock-adapter.js";
import { AnthropicMessagesAdapter } from "./anthropic-adapter.js";
import { GeminiChatAdapter } from "./gemini-adapter.js";
import { decodeOpenAIToolArguments } from "./tool-arguments.js";

const routes = [
  "openai",
  "anthropic",
  "google",
  "langdock-openai",
  "langdock-anthropic",
  "langdock-google",
] as const;
type Route = (typeof routes)[number];
const tool: AgentModelToolSpec = {
  name: "inspect",
  description: "Inspect",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const createAdapter = (
  route: Route,
  value: unknown,
  definition = tool,
  raw?: string,
): { adapter: AgentModelAdapter; model: string } => {
  if (route === "openai") {
    const client = {
      responses: {
        create: async () => ({
          id: "response",
          output: [
            {
              type: "function_call",
              call_id: "call",
              name: definition.name,
              arguments: raw ?? JSON.stringify(value),
            },
          ],
        }),
      },
    } as unknown as OpenAI;
    return {
      adapter: new OpenAIResponsesAdapter(client, [definition]),
      model: "gpt-5.2",
    };
  }
  if (route === "langdock-openai") {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      type: "function",
                      id: "call",
                      function: {
                        name: definition.name,
                        arguments: raw ?? JSON.stringify(value),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        },
      },
    } as unknown as OpenAI;
    return {
      adapter: new LangdockChatCompletionsAdapter(client, [definition]),
      model: "gpt-5",
    };
  }
  if (route === "anthropic" || route === "langdock-anthropic") {
    const client = {
      messages: {
        create: async () => ({
          content: [
            {
              type: "tool_use",
              id: "call",
              name: definition.name,
              input: value,
            },
          ],
          stop_reason: "tool_use",
        }),
      },
    } as unknown as Anthropic;
    return {
      adapter: new AnthropicMessagesAdapter(
        client,
        [definition],
        route === "anthropic" ? "anthropic" : "langdock",
      ),
      model: "claude-sonnet-4-5",
    };
  }
  const client = {
    chats: {
      create: () => ({
        sendMessage: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: "call",
                      name: definition.name,
                      args: value,
                    },
                  },
                ],
              },
            },
          ],
        }),
      }),
    },
  } as unknown as GoogleGenAI;
  return {
    adapter: new GeminiChatAdapter(
      client,
      "gemini-3-pro",
      [definition],
      route === "google" ? "google" : "langdock",
    ),
    model: "gemini-3-pro",
  };
};

it.each(routes)(
  "%s rejects invalid argument shapes before executing even a zero-argument tool",
  async (route) => {
    for (const value of [null, [], [1], 7, "text", true]) {
      const { adapter, model } = createAdapter(route, value);
      const turn = await adapter.startTurn({
        model,
        systemPrompt: "Inspect",
        userPrompt: "Inspect",
        tools: [tool],
      });
      const call = turn.toolCalls[0]!;
      expect(call.argumentError).toContain("JSON object");
      const execute = vi.fn();
      const outcome = await executeToolCall(
        runtimeConfig,
        {
          sessionEnabled: false,
          sessionEntries: [],
          globalEnabled: false,
          globalEntries: [],
        },
        undefined,
        new Map([
          [
            tool.name,
            {
              spec: tool,
              backingTool: "utilities",
              effect: "read",
              riskLevel: "low",
              execute,
            },
          ],
        ]),
        call,
      );
      expect(outcome.result?.toolResult.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    }
  },
);

it.each(routes)(
  "%s accepts zero-argument objects without changing their meaning",
  async (route) => {
    const { adapter, model } = createAdapter(route, {});
    const turn = await adapter.startTurn({
      model,
      systemPrompt: "Inspect",
      userPrompt: "Inspect",
      tools: [tool],
    });
    expect(turn.toolCalls[0]).toMatchObject({ name: "inspect", arguments: {} });
    expect(turn.toolCalls[0]).not.toHaveProperty("argumentError");
  },
);

it.each(["openai", "langdock-openai"] as const)(
  "%s returns malformed JSON to the model as a recoverable tool error",
  async (route) => {
    const { adapter, model } = createAdapter(route, {}, tool, '{"broken":');
    const turn = await adapter.startTurn({
      model,
      systemPrompt: "Inspect",
      userPrompt: "Inspect",
      tools: [tool],
    });
    expect(turn.toolCalls[0]).toMatchObject({
      rawArguments: '{"broken":',
      argumentError: expect.stringContaining("valid JSON object"),
    });
  },
);

it.each(["openai", "langdock-openai"] as const)(
  "%s restores omitted optional fields while preserving explicit nullable data",
  async (route) => {
    const definition: AgentModelToolSpec = {
      ...tool,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 25 },
          explicit: { type: ["string", "null"] },
          nested: {
            type: "array",
            items: {
              type: "object",
              properties: { value: { type: "integer" } },
              additionalProperties: false,
            },
          },
        },
        required: ["path"],
      },
    };
    const { adapter, model } = createAdapter(
      route,
      { path: "notes", limit: null, explicit: null, nested: [{ value: null }] },
      definition,
    );
    const turn = await adapter.startTurn({
      model,
      systemPrompt: "Inspect",
      userPrompt: "Inspect",
      tools: [definition],
    });
    expect(turn.toolCalls[0]?.arguments).toEqual({
      path: "notes",
      explicit: null,
      nested: [{}],
    });
    expect(
      validateToolArguments(
        definition.inputSchema,
        turn.toolCalls[0]!.arguments,
      ),
    ).toBeUndefined();
    const invalid = decodeOpenAIToolArguments(
      '{"path":null,"limit":26}',
      definition,
    );
    expect(invalid.arguments).toEqual({ path: null, limit: 26 });
    expect(
      validateToolArguments(definition.inputSchema, invalid.arguments),
    ).toBeDefined();
  },
);

it("preserves null in arbitrary JSON and non-strict tools", () => {
  const definition = { ...tool, strict: false };
  expect(
    decodeOpenAIToolArguments('{"data":null}', definition).arguments,
  ).toEqual({ data: null });
  const schema = {
    type: "object",
    properties: {
      data: {},
      constant: { const: null },
      choice: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };
  expect(
    decodeOpenAIToolArguments('{"data":null,"constant":null,"choice":null}', {
      ...tool,
      inputSchema: schema,
    }).arguments,
  ).toEqual({ data: null, constant: null, choice: null });
});

it("restores nested optional fields declared through local references", () => {
  const schema = {
    type: "object",
    $defs: {
      row: { type: "object", properties: { count: { type: "integer" } } },
    },
    properties: {
      row: { $ref: "#/$defs/row" },
      optional: { $ref: "#/$defs/row" },
    },
    required: ["row"],
  };
  const decoded = decodeOpenAIToolArguments(
    '{"row":{"count":null},"optional":null}',
    { ...tool, inputSchema: schema },
  );
  expect(decoded.arguments).toEqual({ row: {} });
  expect(validateToolArguments(schema, decoded.arguments)).toBeUndefined();
});

it.each(routes)(
  "%s carries every filesystem argument and enforces its schema",
  async (route) => {
    const examples: Record<string, Record<string, unknown>> = {
      list_directory: { path: ".", maxEntries: 60 },
      read_file: { path: "notes.txt", startLine: 1, endLine: 2 },
      search_workspace: { query: "notes", isRegex: false, maxResults: 25 },
      create_file: { path: "notes.txt", content: "Notes" },
      replace_in_file: {
        path: "notes.txt",
        oldText: "Notes",
        newText: "Updated",
        replaceAll: false,
      },
    };
    for (const definition of createFilesystemToolDefinitions()) {
      const value = examples[definition.spec.name]!;
      const { adapter, model } = createAdapter(route, value, definition.spec);
      const turn = await adapter.startTurn({
        model,
        systemPrompt: "Inspect",
        userPrompt: "Inspect",
        tools: [definition.spec],
      });
      expect(turn.toolCalls[0]?.arguments).toEqual(value);
      expect(
        validateToolArguments(
          definition.spec.inputSchema,
          turn.toolCalls[0]!.arguments,
        ),
      ).toBeUndefined();
      for (const key of definition.spec.inputSchema.required as string[]) {
        const missing = { ...value };
        delete missing[key];
        expect(
          validateToolArguments(definition.spec.inputSchema, missing),
          `${definition.spec.name}.${key}`,
        ).toBeDefined();
      }
      expect(
        validateToolArguments(definition.spec.inputSchema, {
          ...value,
          invented: true,
        }),
      ).toBeDefined();
    }
  },
);

it("restores optional arguments inside alternative object schemas", () => {
  const schema = {
    type: "object",
    properties: {
      choice: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "first" },
              optional: { type: "string" },
            },
            required: ["kind"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "second" },
              optional: { type: "integer" },
            },
            required: ["kind"],
          },
        ],
      },
    },
  };
  const decoded = decodeOpenAIToolArguments(
    '{"choice":{"kind":"second","optional":null}}',
    { ...tool, inputSchema: schema },
  );
  expect(decoded.arguments).toEqual({ choice: { kind: "second" } });
  expect(validateToolArguments(schema, decoded.arguments)).toBeUndefined();
});

it("preserves valid null data in an alternative while removing an unrelated omitted field", () => {
  const schema = {
    type: "object",
    properties: {
      optional: { type: "integer" },
      choice: {
        anyOf: [
          { type: "object", properties: { value: { type: "string" } } },
          { type: "object", properties: { value: { type: "null" } } },
        ],
      },
    },
  };
  const decoded = decodeOpenAIToolArguments(
    '{"optional":null,"choice":{"value":null}}',
    { ...tool, inputSchema: schema },
  );
  expect(decoded.arguments).toEqual({ choice: { value: null } });
});

it.each(["google", "langdock"] as const)(
  "%s rejects invalid arguments in streamed Gemini calls",
  async (provider) => {
    const client = {
      chats: {
        create: () => ({
          sendMessageStream: async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: { id: "call", name: "inspect", args: [] },
                      },
                    ],
                  },
                },
              ],
            };
          },
        }),
      },
    } as unknown as GoogleGenAI;
    const adapter = new GeminiChatAdapter(
      client,
      "gemini-3-pro",
      [tool],
      provider,
    );
    const turn = await adapter.startTurn({
      model: "gemini-3-pro",
      systemPrompt: "Inspect",
      userPrompt: "Inspect",
      tools: [tool],
      onStreamEvent: () => undefined,
    });
    expect(turn.toolCalls[0]?.argumentError).toContain("JSON object");
  },
);
