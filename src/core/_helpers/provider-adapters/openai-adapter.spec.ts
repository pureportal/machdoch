import type OpenAI from "openai";
import type {
  AgentModelStartParams,
  AgentModelStreamEvent,
  AgentModelToolSpec,
} from "../../types.js";
import { TASK_EXECUTION_TIMEOUT_MS } from "../agent-runtime-types.js";
import {
  OpenAIResponsesAdapter,
  createOpenAIReasoningConfig,
  createOpenAIResponseToolSelection,
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

  it("normalizes reasoning effort for the selected OpenAI model", () => {
    expect(createOpenAIReasoningConfig("gpt-5.5", "max")).toEqual({
      reasoning: { effort: "xhigh" },
    });
    expect(createOpenAIReasoningConfig("gpt-5", "none")).toEqual({
      reasoning: { effort: "minimal" },
    });
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
