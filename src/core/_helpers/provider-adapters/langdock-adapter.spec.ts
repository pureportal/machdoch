import type OpenAI from "openai";
import type {
  AgentModelStartParams,
  AgentModelToolSpec,
} from "../../types.js";
import { TASK_EXECUTION_TIMEOUT_MS } from "../agent-runtime-types.js";
import {
  LangdockChatCompletionsAdapter,
  createLangdockReasoningConfig,
  createLangdockToolSelection,
} from "./langdock-adapter.js";

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
  model: "gpt-5",
  systemPrompt: "System prompt.",
  userPrompt: "Read README.md",
  tools: [tool],
};

describe("Langdock Chat Completions conformance", () => {
  it("requires a tool call without unsupported parallel tool flags", () => {
    expect(createLangdockToolSelection([tool])).toEqual({
      tool_choice: "required",
    });
    expect(createLangdockToolSelection([])).toEqual({});
  });

  it("normalizes reasoning effort for Langdock-routed model families", () => {
    expect(createLangdockReasoningConfig("gpt-5", "none")).toEqual({
      reasoning_effort: "minimal",
    });
    expect(createLangdockReasoningConfig("gemini-2.5-pro", "max")).toEqual({
      reasoning_effort: "high",
    });
  });

  it("sends start and continuation turns using Chat Completions messages", async () => {
    const calls: Array<{ body: unknown; options: unknown }> = [];
    const responses = [
      {
        id: "chat_1",
        object: "chat.completion",
        created: 1,
        model: "gpt-5",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            logprobs: null,
            message: {
              role: "assistant",
              content: " Need the file. ",
              refusal: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "inspect_file",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: "chat_2",
        object: "chat.completion",
        created: 2,
        model: "gpt-5",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            logprobs: null,
            message: {
              role: "assistant",
              content: " Done. ",
              refusal: null,
            },
          },
        ],
      },
    ];
    const client = {
      chat: {
        completions: {
          create: async (body: unknown, options: unknown) => {
            calls.push({ body, options });
            return responses.shift();
          },
        },
      },
    } as unknown as OpenAI;
    const adapter = new LangdockChatCompletionsAdapter(client, [tool]);

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
      model: "gpt-5",
      messages: [
        { role: "system", content: "System prompt." },
        { role: "user", content: "Read README.md" },
      ],
      tool_choice: "required",
      tools: [
        {
          type: "function",
          function: {
            name: "inspect_file",
            strict: true,
          },
        },
      ],
    });
    expect(calls[0]?.body).not.toHaveProperty("parallel_tool_calls");
    expect(calls[0]?.body).not.toHaveProperty("stream_options");
    expect(calls[0]?.options).toMatchObject({
      timeout: TASK_EXECUTION_TIMEOUT_MS,
    });
    expect(calls[1]?.body).toMatchObject({
      messages: [
        { role: "system", content: "System prompt." },
        { role: "user", content: "Read README.md" },
        {
          role: "assistant",
          content: " Need the file. ",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "inspect_file",
                arguments: "{\"path\":\"README.md\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "contents",
        },
      ],
    });
  });
});
