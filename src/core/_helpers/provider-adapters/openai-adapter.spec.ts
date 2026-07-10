import type OpenAI from "openai";
import type {
  AgentModelStartParams,
  AgentModelStreamEvent,
  AgentModelToolSpec,
} from "../../types.js";
import { TASK_EXECUTION_TIMEOUT_MS } from "../agent-runtime-types.js";
import {
  OpenAIResponsesAdapter,
  createOpenAIMultiAgentConfig,
  createOpenAIReasoningConfig,
  createOpenAIResponseToolSelection,
  createOpenAITools,
  createOpenAIStructuredOutputTextConfig,
  createOpenAIUserInput,
} from "./openai-adapter.js";

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
  model: "gpt-5.2",
  systemPrompt: "System prompt.",
  userPrompt: "Read README.md",
  tools: [tool],
};

describe("OpenAI Responses conformance", () => {
  it("requires one tool call per turn", () => {
    expect(createOpenAIResponseToolSelection()).toEqual({
      parallel_tool_calls: false,
      tool_choice: "required",
    });
  });

  it("preserves non-strict tool schemas for arbitrary nested JSON arguments", () => {
    expect(
      createOpenAITools([
        {
          name: "mcp_call_tool",
          description: "Call a remote MCP tool.",
          strict: false,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["serverId", "toolName", "arguments"],
            properties: {
              serverId: { type: "string" },
              toolName: { type: "string" },
              arguments: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
        },
      ]),
    ).toEqual([
      {
        type: "function",
        name: "mcp_call_tool",
        description: "Call a remote MCP tool.",
        strict: false,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["serverId", "toolName", "arguments"],
          properties: {
            serverId: { type: "string" },
            toolName: { type: "string" },
            arguments: {
              type: "object",
              additionalProperties: true,
            },
          },
        },
      },
    ]);
  });

  it("normalizes reasoning effort for the selected OpenAI model", () => {
    expect(createOpenAIReasoningConfig("gpt-5.5", "max")).toEqual({
      reasoning: { effort: "xhigh" },
    });
    expect(createOpenAIReasoningConfig("gpt-5.6-sol", "max")).toEqual({
      reasoning: { effort: "max" },
    });
    expect(createOpenAIReasoningConfig("gpt-5.6-sol", "ultra")).toEqual({
      reasoning: { effort: "max" },
    });
    expect(createOpenAIReasoningConfig("gpt-5", "none")).toEqual({
      reasoning: { effort: "minimal" },
    });
  });

  it("enables four-agent Ultra orchestration only for GPT-5.6", () => {
    expect(createOpenAIMultiAgentConfig("gpt-5.6-sol", "ultra")).toEqual({
      multi_agent: {
        enabled: true,
        max_concurrent_subagents: 4,
      },
      betas: ["responses_multi_agent=v1"],
    });
    expect(createOpenAIMultiAgentConfig("gpt-5.6-terra", "max")).toEqual({});
    expect(createOpenAIMultiAgentConfig("gpt-5.5", "ultra")).toEqual({});
  });

  it("serializes image inputs for the Responses API", () => {
    expect(
      createOpenAIUserInput({
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
        role: "user",
        content: [
          { type: "input_text", text: "Describe this screen" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
          },
        ],
      },
    ]);
  });

  it("serializes structured output requests for the Responses API", () => {
    expect(
      createOpenAIStructuredOutputTextConfig({
        name: "Ralph Prompt JSON!",
        strict: true,
        schema: {
          type: "object",
          properties: { decision: { type: "string" } },
          required: ["decision"],
        },
      }),
    ).toEqual({
      text: {
        format: {
          type: "json_schema",
          name: "Ralph_Prompt_JSON",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { decision: { type: "string" } },
            required: ["decision"],
          },
        },
      },
    });
  });

  it("sends start and continuation turns using Responses request ids", async () => {
    const calls: Array<{ body: unknown; options: unknown }> = [];
    const responses = [
      {
        id: "resp_1",
        output_text: " Need the file. ",
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "inspect_file",
            arguments: "{\"path\":\"README.md\"}",
          },
        ],
      },
      {
        id: "resp_2",
        output_text: " Done. ",
        output: [],
      },
    ];
    const client = {
      responses: {
        create: async (body: unknown, options: unknown) => {
          calls.push({ body, options });
          return responses.shift() ?? { id: "resp_fallback", output: [] };
        },
      },
    } as unknown as OpenAI;
    const adapter = new OpenAIResponsesAdapter(client, [tool]);

    await expect(adapter.startTurn(startParams)).resolves.toEqual({
      text: "Need the file.",
      toolCalls: [
        {
          id: "call_1",
          name: "inspect_file",
          arguments: { path: "README.md" },
          rawArguments: "{\"path\":\"README.md\"}",
        },
      ],
    });
    await expect(
      adapter.continueTurn({
        toolResults: [
          {
            callId: "call_1",
            name: "inspect_file",
            output: "contents",
          },
        ],
      }),
    ).resolves.toEqual({
      text: "Done.",
      toolCalls: [],
    });

    expect(calls[0]?.body).toMatchObject({
      model: "gpt-5.2",
      instructions: "System prompt.",
      input: "Read README.md",
      parallel_tool_calls: false,
      tool_choice: "required",
      tools: [
        {
          type: "function",
          name: "inspect_file",
          strict: true,
        },
      ],
    });
    expect(calls[0]?.options).toMatchObject({
      timeout: TASK_EXECUTION_TIMEOUT_MS,
    });
    expect(calls[1]?.body).toMatchObject({
      previous_response_id: "resp_1",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "contents",
        },
      ],
    });
  });

  it("routes GPT-5.6 Ultra turns through the multi-agent beta", async () => {
    const standardCreate = vi.fn();
    const betaCreate = vi.fn(async () => ({
      id: "resp_ultra",
      output: [
        {
          type: "message",
          phase: "final_answer",
          agent: { agent_name: "/root/researcher" },
          content: [{ type: "output_text", text: "Subagent draft." }],
        },
        {
          type: "message",
          phase: "final_answer",
          agent: { agent_name: "/root" },
          content: [{ type: "output_text", text: "Synthesized result." }],
        },
      ],
    }));
    const client = {
      responses: { create: standardCreate },
      beta: { responses: { create: betaCreate } },
    } as unknown as OpenAI;
    const adapter = new OpenAIResponsesAdapter(client, [tool]);

    await expect(
      adapter.startTurn({
        ...startParams,
        model: "gpt-5.6-sol",
        reasoning: "ultra",
      }),
    ).resolves.toEqual({
      text: "Synthesized result.",
      toolCalls: [],
    });

    expect(standardCreate).not.toHaveBeenCalled();
    expect(betaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        reasoning: { effort: "max" },
        multi_agent: {
          enabled: true,
          max_concurrent_subagents: 4,
        },
        betas: ["responses_multi_agent=v1"],
      }),
      expect.objectContaining({ timeout: TASK_EXECUTION_TIMEOUT_MS }),
    );
  });

  it("streams only root-agent text from GPT-5.6 Ultra", async () => {
    const events: AgentModelStreamEvent[] = [];
    const completedResponse = {
      id: "resp_ultra_stream",
      output: [
        {
          type: "message",
          phase: "final_answer",
          agent: { agent_name: "/root" },
          content: [{ type: "output_text", text: "Root result." }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    };
    const betaCreate = vi.fn(async () => ({
      controller: { abort: vi.fn() },
      async *[Symbol.asyncIterator]() {
        yield { type: "response.created", response: { id: "resp_ultra_stream" } };
        yield {
          type: "response.output_text.delta",
          agent: { agent_name: "/root/researcher" },
          delta: "Subagent draft.",
        };
        yield {
          type: "response.output_text.delta",
          agent: { agent_name: "/root" },
          delta: "Root result.",
        };
        yield { type: "response.completed", response: completedResponse };
      },
    }));
    const client = {
      responses: { stream: vi.fn() },
      beta: { responses: { create: betaCreate } },
    } as unknown as OpenAI;
    const adapter = new OpenAIResponsesAdapter(client, [tool]);

    await expect(
      adapter.startTurn({
        ...startParams,
        model: "gpt-5.6-sol",
        reasoning: "ultra",
        onStreamEvent: (event) => events.push(event),
      }),
    ).resolves.toEqual({
      text: "Root result.",
      toolCalls: [],
    });

    expect(
      events.filter((event) => event.type === "text-delta"),
    ).toEqual([
      { type: "text-delta", provider: "openai", delta: "Root result." },
    ]);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
  });

  it("normalizes streamed Responses events", async () => {
    const events: AgentModelStreamEvent[] = [];
    const stream = {
      abort: vi.fn(),
      on: vi.fn(),
      finalResponse: async () => {
        const eventHandler = stream.on.mock.calls.find(
          ([eventName]) => eventName === "event",
        )?.[1] as (event: unknown) => void;

        eventHandler({ type: "response.created" });
        eventHandler({
          type: "response.output_text.delta",
          delta: "Need ",
        });
        eventHandler({
          type: "response.output_item.added",
          item: {
            id: "item_1",
            type: "function_call",
            name: "inspect_file",
          },
        });
        eventHandler({
          type: "response.function_call_arguments.delta",
          item_id: "item_1",
          delta: "{\"path\"",
        });
        eventHandler({
          type: "response.function_call_arguments.done",
          item_id: "item_1",
          name: "inspect_file",
          arguments: "{\"path\":\"README.md\"}",
        });
        eventHandler({
          type: "response.output_item.done",
          item: {
            id: "item_1",
            type: "function_call",
            name: "inspect_file",
          },
        });
        eventHandler({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 12,
              output_tokens: 7,
              total_tokens: 19,
            },
          },
        });

        return {
          id: "resp_stream",
          output_text: "Need the file.",
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            total_tokens: 19,
          },
          output: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "inspect_file",
              arguments: "{\"path\":\"README.md\"}",
            },
          ],
        };
      },
    };
    const client = {
      responses: {
        stream: vi.fn(() => stream),
      },
    } as unknown as OpenAI;
    const adapter = new OpenAIResponsesAdapter(client, [tool]);

    await expect(
      adapter.startTurn({
        ...startParams,
        onStreamEvent: (event) => events.push(event),
      }),
    ).resolves.toMatchObject({
      text: "Need the file.",
      toolCalls: [{ id: "call_1", name: "inspect_file" }],
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "status", provider: "openai" }),
        { type: "text-delta", provider: "openai", delta: "Need " },
        expect.objectContaining({
          type: "tool-call-start",
          provider: "openai",
          name: "inspect_file",
        }),
        expect.objectContaining({
          type: "tool-call-arguments-delta",
          provider: "openai",
          delta: "{\"path\"",
        }),
        expect.objectContaining({
          type: "tool-call-done",
          provider: "openai",
          argumentsText: "{\"path\":\"README.md\"}",
        }),
        expect.objectContaining({
          type: "usage",
          provider: "openai",
          usage: expect.objectContaining({ totalTokens: 19 }),
        }),
      ]),
    );
    expect(events.filter((event) => event.type === "tool-call-done")).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
  });
});
