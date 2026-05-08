import type OpenAI from "openai";
import type {
  AgentModelStartParams,
  AgentModelToolSpec,
} from "../../types.js";
import { TASK_EXECUTION_TIMEOUT_MS } from "../agent-runtime-types.js";
import {
  OpenAIResponsesAdapter,
  createOpenAIResponseToolSelection,
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
});
