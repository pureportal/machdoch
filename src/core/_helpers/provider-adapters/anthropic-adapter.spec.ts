import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentModelStartParams,
  AgentModelStreamEvent,
  AgentModelToolSpec,
} from "../../types.js";
import { TASK_EXECUTION_TIMEOUT_MS } from "../agent-runtime-types.js";
import {
  AnthropicMessagesAdapter,
  createAnthropicOutputConfig,
  createAnthropicToolSelection,
  createAnthropicUserContent,
} from "./anthropic-adapter.js";

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
  it("requires one tool call per turn", () => {
    expect(createAnthropicToolSelection()).toEqual({
      tool_choice: {
        type: "any",
        disable_parallel_tool_use: true,
      },
    });
  });

  it("normalizes effort for the selected Claude model", () => {
    expect(
      createAnthropicOutputConfig("claude-sonnet-4-6", "xhigh"),
    ).toEqual({
      output_config: { effort: "high" },
    });
    expect(
      createAnthropicOutputConfig("claude-sonnet-4-6", "max"),
    ).toEqual({
      output_config: { effort: "max" },
    });
    expect(createAnthropicOutputConfig("claude-haiku-4-5", "high")).toEqual(
      {},
    );
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
      max_tokens: 4096,
      system: "System prompt.",
      messages: [{ role: "user", content: "Read README.md" }],
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
    expect(calls[0]?.options).toMatchObject({
      timeout: TASK_EXECUTION_TIMEOUT_MS,
    });
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
            },
          ],
        },
      ],
    });
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
            partial_json: "{\"path\":\"README.md\"}",
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
          snapshot: "{\"path\":\"README.md\"}",
        }),
        expect.objectContaining({
          type: "tool-call-done",
          provider: "anthropic",
          argumentsText: "{\"path\":\"README.md\"}",
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
