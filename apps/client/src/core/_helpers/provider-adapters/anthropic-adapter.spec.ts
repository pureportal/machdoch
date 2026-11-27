import type Anthropic from "@anthropic-ai/sdk";
import type { AgentModelStartParams, AgentModelStreamEvent, AgentModelToolSpec } from "@machdoch/model-runtime/types";
import { AnthropicMessagesAdapter, createAnthropicOutputConfig, createAnthropicThinkingConfig, getAnthropicMaxOutputTokens, createAnthropicToolSelection, createAnthropicUserContent } from "@machdoch/model-runtime/providers/anthropic-adapter";
import { rememberDiscoveredModelCapabilities } from "@machdoch/model-runtime/model-capabilities";

const tool: AgentModelToolSpec = {
  name: "inspect_file",
  description: "Inspect a workspace file.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
};

const startParams: AgentModelStartParams = {
  model: "claude-sonnet-4-5",
  systemPrompt: "System prompt.",
  userPrompt: "Read README.md",
  tools: [tool],
};

describe("Anthropic Messages conformance", () => {
  it("forces one tool call per turn on models without adaptive thinking", () => {
    expect(createAnthropicToolSelection("claude-sonnet-4-5", [tool])).toEqual({
      tool_choice: {
        type: "any",
        disable_parallel_tool_use: true,
      },
    });
    expect(createAnthropicToolSelection("claude-sonnet-4-5", [])).toEqual({});
  });

  it.each([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-2",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-default",
  ])("lets %s think before choosing a tool", (model) => {
    expect(createAnthropicToolSelection(model, [tool])).toEqual({
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
    expect(createAnthropicThinkingConfig(model)).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
    });
  });

  it("leaves thinking unset on models without adaptive thinking", () => {
    expect(createAnthropicThinkingConfig("claude-haiku-4-5")).toEqual({});
    expect(createAnthropicThinkingConfig("claude-sonnet-4-5")).toEqual({});
  });

  it("validates effort for the selected Claude model", () => {
    expect(createAnthropicOutputConfig("claude-sonnet-4-6", "max")).toEqual({
      output_config: { effort: "max" },
    });
    expect(() =>
      createAnthropicOutputConfig("claude-sonnet-4-6", "xhigh"),
    ).toThrow("Reasoning mode `xhigh` is not supported");
    expect(() =>
      createAnthropicOutputConfig("claude-sonnet-5", "ultra"),
    ).toThrow("Reasoning mode `ultra` is not supported");
    expect(() =>
      createAnthropicOutputConfig("claude-haiku-4-5", "high"),
    ).toThrow("Reasoning mode `high` is not supported");
    expect(createAnthropicOutputConfig("claude-haiku-5-5", "xhigh")).toEqual({
      output_config: { effort: "xhigh" },
    });
  });

  it("combines effort with native structured output", () => {
    expect(
      createAnthropicOutputConfig("claude-sonnet-4-6", "high", "anthropic", {
        name: "memory_decisions",
        schema: {
          type: "object",
          properties: { decisions: { type: "array" } },
          required: ["decisions"],
        },
      }),
    ).toEqual({
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { decisions: { type: "array" } },
            required: ["decisions"],
          },
        },
      },
    });
  });

  it("requests native structured output without forcing tool use", async () => {
    const calls: unknown[] = [];
    const client = {
      messages: {
        create: async (body: unknown) => {
          calls.push(body);
          return {
            content: [{ type: "text", text: '{"decisions":[]}' }],
            stop_reason: "end_turn",
          };
        },
      },
    } as unknown as Anthropic;
    const adapter = new AnthropicMessagesAdapter(client, []);

    await adapter.startTurn({
      model: "claude-sonnet-4-6",
      systemPrompt: "Extract decisions.",
      userPrompt: "Review this task.",
      tools: [],
      structuredOutput: {
        name: "memory_decisions",
        schema: {
          type: "object",
          properties: { decisions: { type: "array" } },
          required: ["decisions"],
        },
      },
    });

    expect(calls[0]).toMatchObject({
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { decisions: { type: "array" } },
            required: ["decisions"],
          },
        },
      },
    });
    expect(calls[0]).not.toHaveProperty("tools");
    expect(calls[0]).not.toHaveProperty("tool_choice");
  });

  it("reserves output capacity for thinking plus large tool calls", () => {
    expect(getAnthropicMaxOutputTokens("anthropic", "claude-opus-5-5", true)).toBe(64_000);
    expect(getAnthropicMaxOutputTokens("anthropic", "claude-opus-5-5", false)).toBe(16_000);
    expect(getAnthropicMaxOutputTokens("anthropic", "claude-haiku-4-5", true)).toBe(64_000);
    rememberDiscoveredModelCapabilities("anthropic", "claude-small-test", {
      maxOutputTokens: 8_192,
    });
    expect(getAnthropicMaxOutputTokens("anthropic", "claude-small-test", true)).toBe(8_192);
  });

  it("places image blocks before text", () => {
    expect(
      createAnthropicUserContent({
        userPrompt: "Describe this screen",
        imageInputs: [
          {
            path: "C:/workspace/screenshot.png",
            mediaType: "image/png",
            data: "ZmFrZS1pbWFnZQ==",
          },
        ],
      }),
    ).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "ZmFrZS1pbWFnZQ==",
        },
      },
      { type: "text", text: "Describe this screen" },
    ]);
  });

  it("keeps Messages history and serializes tool results", async () => {
    const calls: Array<{ body: unknown; options: unknown }> = [];
    const messages = [
      {
        content: [
          { type: "text", text: "Need the file." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "inspect_file",
            input: { path: "README.md" },
          },
        ],
        stop_reason: "tool_use",
      },
      {
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
      },
    ];
    const client = {
      messages: {
        create: async (body: unknown, options: unknown) => {
          calls.push({ body, options });
          return messages.shift() ?? { content: [], stop_reason: "end_turn" };
        },
      },
    } as unknown as Anthropic;
    const adapter = new AnthropicMessagesAdapter(client, [tool]);

    await expect(adapter.startTurn(startParams)).resolves.toEqual({
      text: "Need the file.",
      stopReason: "tool_use",
      toolCalls: [
        {
          id: "toolu_1",
          name: "inspect_file",
          arguments: { path: "README.md" },
        },
      ],
    });
    await expect(
      adapter.continueTurn({
        toolResults: [
          {
            callId: "toolu_1",
            name: "inspect_file",
            output: "contents",
          },
        ],
      }),
    ).resolves.toEqual({
      text: "Done.",
      stopReason: "end_turn",
      toolCalls: [],
    });

    expect(calls[0]?.body).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: 16_000,
      system: [
        {
          type: "text",
          text: "System prompt.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Read README.md",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      tool_choice: {
        type: "any",
        disable_parallel_tool_use: true,
      },
      tools: [
        {
          name: "inspect_file",
          strict: true,
          input_schema: {
            type: "object",
          },
        },
      ],
    });
    expect(calls[0]?.options).not.toHaveProperty("timeout");
    expect(calls[1]?.body).toMatchObject({
      messages: [
        { role: "user", content: "Read README.md" },
        { role: "assistant" },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "contents",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    expect(
      JSON.stringify((calls[1]?.body as { messages: unknown }).messages).match(
        /cache_control/gu,
      ),
    ).toHaveLength(1);
  });

  it("requests adaptive thinking without forcing tool use on current models", async () => {
    const calls: unknown[] = [];
    const client = {
      messages: {
        create: async (body: unknown) => {
          calls.push(body);
          return { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
        },
      },
    } as unknown as Anthropic;
    const adapter = new AnthropicMessagesAdapter(client, [tool]);

    await adapter.startTurn({ ...startParams, model: "claude-opus-5-5", toolChoice: "required" });

    expect(calls[0]).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
  });

  it("does not run tool calls cut off by the output token limit", async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [
            {
              type: "tool_use",
              id: "toolu_cut",
              name: "inspect_file",
              input: { path: "REA" },
            },
          ],
          stop_reason: "max_tokens",
        }),
      },
    } as unknown as Anthropic;
    const adapter = new AnthropicMessagesAdapter(client, [tool]);

    const turn = await adapter.startTurn(startParams);

    expect(turn.stopReason).toBe("max_tokens");
    expect(turn.toolCalls[0]?.argumentError).toContain("output token limit");
  });

  it("reports refusals with their category", async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [],
          stop_reason: "refusal",
          stop_details: {
            type: "refusal",
            category: "cyber",
            explanation: "Declined by policy.",
          },
        }),
      },
    } as unknown as Anthropic;
    const adapter = new AnthropicMessagesAdapter(client, [tool]);

    await expect(adapter.startTurn(startParams)).rejects.toThrow(
      "Claude declined this request (cyber). Declined by policy.",
    );
  });

  it("normalizes streamed Messages events", async () => {
    const events: AgentModelStreamEvent[] = [];
    const stream = {
      abort: vi.fn(),
      on: vi.fn(),
      finalMessage: async () => {
        const textHandler = stream.on.mock.calls.find(
          ([eventName]) => eventName === "text",
        )?.[1] as (text: string) => void;
        const streamEventHandler = stream.on.mock.calls.find(
          ([eventName]) => eventName === "streamEvent",
        )?.[1] as (event: unknown) => void;

        streamEventHandler({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              output_tokens: 1,
            },
          },
        });
        textHandler("Need ");
        streamEventHandler({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "I should inspect the file.",
          },
        });
        streamEventHandler({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "inspect_file",
            input: {},
          },
        });
        streamEventHandler({
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"path":"README.md"}',
          },
        });
        streamEventHandler({
          type: "content_block_stop",
          index: 1,
        });
        streamEventHandler({
          type: "message_delta",
          usage: {
            output_tokens: 9,
          },
        });
        streamEventHandler({ type: "message_stop" });

        return {
          content: [
            { type: "text", text: "Need the file." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "inspect_file",
              input: { path: "README.md" },
            },
          ],
          stop_reason: "tool_use",
        };
      },
    };
    const client = {
      messages: {
        stream: vi.fn(() => stream),
      },
    } as unknown as Anthropic;
    const adapter = new AnthropicMessagesAdapter(client, [tool]);

    await expect(
      adapter.startTurn({
        ...startParams,
        onStreamEvent: (event) => events.push(event),
      }),
    ).resolves.toMatchObject({
      text: "Need the file.",
      toolCalls: [{ id: "toolu_1", name: "inspect_file" }],
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "status", provider: "anthropic" }),
        { type: "text-delta", provider: "anthropic", delta: "Need " },
        expect.objectContaining({
          type: "reasoning-delta",
          provider: "anthropic",
          delta: "I should inspect the file.",
        }),
        expect.objectContaining({
          type: "tool-call-start",
          provider: "anthropic",
          name: "inspect_file",
        }),
        expect.objectContaining({
          type: "tool-call-arguments-delta",
          provider: "anthropic",
          snapshot: '{"path":"README.md"}',
        }),
        expect.objectContaining({
          type: "tool-call-done",
          provider: "anthropic",
          argumentsText: '{"path":"README.md"}',
        }),
        expect.objectContaining({
          type: "usage",
          provider: "anthropic",
          usage: expect.objectContaining({ outputTokens: 9 }),
        }),
      ]),
    );
  });
});
