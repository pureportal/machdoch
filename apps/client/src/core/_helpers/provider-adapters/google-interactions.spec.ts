import { expect, it, vi } from "vitest";
import type { GoogleGenAI, Interactions } from "@google/genai";
import {
  GoogleInteractionsAdapter,
  normalizeInteractionUsage,
} from "@machdoch/model-runtime/providers/google-interactions";
import type {
  AgentModelStartParams,
  AgentModelStreamEvent,
} from "@machdoch/model-runtime/types";

const input: AgentModelStartParams = {
  model: "gemini-3.5-flash-lite",
  systemPrompt: "System",
  userPrompt: "Question",
  tools: [],
  maxOutputTokens: 64,
  maxRequestAttempts: 1,
};
const reply: Interactions.Interaction = {
  id: "interaction-1",
  status: "completed",
  steps: [
    { type: "model_output", content: [{ type: "text", text: "Answer" }] },
  ],
  usage: {
    total_input_tokens: 10,
    total_output_tokens: 4,
    total_thought_tokens: 2,
    total_tokens: 16,
  },
};
const adapter = (create: ReturnType<typeof vi.fn>) =>
  new GoogleInteractionsAdapter({
    interactions: { create },
  } as unknown as GoogleGenAI);

it("uses stable Interactions without provider storage or built-in tools", async () => {
  const create = vi.fn().mockResolvedValue(reply);
  const client = adapter(create);
  expect(await client.startTurn(input)).toMatchObject({
    text: "Answer",
    toolCalls: [],
    usage: { totalTokens: 16, reasoningTokens: 2 },
  });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      api_version: "v1",
      store: false,
      background: false,
      tools: [],
      input: [
        { type: "user_input", content: [{ type: "text", text: "Question" }] },
      ],
      generation_config: { tool_choice: "none", max_output_tokens: 64 },
    }),
    expect.objectContaining({ maxRetries: 0 }),
  );
});

it("retains tool identities, thought signatures and image results across stateless continuations", async () => {
  const steps: Interactions.Step[] = [
    {
      type: "thought",
      signature: "opaque-signature",
      summary: [{ type: "text", text: "Inspect the image" }],
    },
    {
      type: "function_call",
      id: "tool-1",
      name: "inspect",
      arguments: { path: "file" },
    },
  ];
  const create = vi
    .fn()
    .mockResolvedValueOnce({ id: "first", status: "requires_action", steps })
    .mockResolvedValueOnce(reply);
  const client = adapter(create);
  const params = {
    ...input,
    tools: [
      {
        name: "inspect",
        description: "Inspect",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    imageInputs: [
      { path: "sample.png", mediaType: "image/png" as const, data: "aW1hZ2U=" },
    ],
  };
  const first = await client.startTurn(params);
  expect(first.toolCalls).toEqual([
    { id: "tool-1", name: "inspect", arguments: { path: "file" } },
  ]);
  await client.continueTurn({
    toolResults: [
      {
        callId: "tool-1",
        name: "inspect",
        output: "Image",
        content: [{ type: "image", mediaType: "image/png", data: "aW1hZ2U=" }],
        isError: false,
      },
    ],
  });
  const request = create.mock.calls[1]![0];
  expect(request).not.toHaveProperty("previous_interaction_id");
  expect(request.input).toEqual(expect.arrayContaining(steps));
  expect(request.input.at(-1)).toMatchObject({
    type: "function_result",
    call_id: "tool-1",
    name: "inspect",
    is_error: false,
    result: expect.arrayContaining([
      { type: "image", mime_type: "image/png", data: "aW1hZ2U=" },
    ]),
  });
});

it("assembles current step events while keeping reasoning separate from the answer", async () => {
  async function* stream(): AsyncGenerator<Interactions.InteractionSSEEvent> {
    yield {
      event_type: "interaction.created",
      interaction: { id: "stream-1", status: "in_progress" },
    };
    yield {
      event_type: "step.start",
      index: 0,
      step: { type: "thought", summary: [] },
    };
    yield {
      event_type: "step.delta",
      index: 0,
      delta: {
        type: "thought_summary",
        content: { type: "text", text: "Reasoning summary" },
      },
    };
    yield {
      event_type: "step.delta",
      index: 0,
      delta: { type: "thought_signature", signature: "signature" },
    };
    yield {
      event_type: "step.start",
      index: 1,
      step: { type: "model_output", content: [] },
    };
    yield {
      event_type: "step.delta",
      index: 1,
      delta: { type: "text", text: "Visible " },
    };
    yield {
      event_type: "step.delta",
      index: 1,
      delta: { type: "text", text: "answer" },
    };
    yield { event_type: "step.stop", index: 1 };
    yield {
      event_type: "interaction.completed",
      interaction: { id: "stream-1", status: "completed", usage: reply.usage },
    };
  }
  const events: AgentModelStreamEvent[] = [];
  const client = adapter(vi.fn().mockResolvedValue(stream()));
  const result = await client.startTurn({
    ...input,
    onStreamEvent: (event) => events.push(event),
  });
  expect(result.text).toBe("Visible answer");
  expect(result.usage?.totalTokens).toBe(16);
  expect(events).toContainEqual({
    type: "reasoning-delta",
    provider: "google",
    delta: "Reasoning summary",
  });
  expect(
    events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.delta)
      .join(""),
  ).toBe("Visible answer");
});

it("decodes function argument deltas and rejects truncated streams", async () => {
  async function* calls(): AsyncGenerator<Interactions.InteractionSSEEvent> {
    yield {
      event_type: "interaction.created",
      interaction: { id: "stream-2", status: "in_progress" },
    };
    yield {
      event_type: "step.start",
      index: 0,
      step: {
        type: "function_call",
        id: "call",
        name: "inspect",
        arguments: {},
      },
    };
    yield {
      event_type: "step.delta",
      index: 0,
      delta: { type: "arguments_delta", arguments: '{"path":' },
    };
    yield {
      event_type: "step.delta",
      index: 0,
      delta: { type: "arguments_delta", arguments: '"file"}' },
    };
    yield { event_type: "step.stop", index: 0 };
    yield {
      event_type: "interaction.status_update",
      interaction_id: "stream-2",
      status: "requires_action",
    };
  }
  const client = adapter(vi.fn().mockResolvedValue(calls()));
  expect(
    (await client.startTurn({ ...input, onStreamEvent: () => {} })).toolCalls,
  ).toEqual([{ id: "call", name: "inspect", arguments: { path: "file" } }]);
  async function* truncated(): AsyncGenerator<Interactions.InteractionSSEEvent> {
    yield {
      event_type: "interaction.created",
      interaction: { id: "unfinished", status: "in_progress" },
    };
  }
  await expect(
    adapter(vi.fn().mockResolvedValue(truncated())).startTurn({
      ...input,
      onStreamEvent: () => {},
    }),
  ).rejects.toThrow("without a terminal event");
});

it("uses current structured output and propagates cancellation without retrying rejected access", async () => {
  const controller = new AbortController();
  const create = vi.fn().mockResolvedValue(reply);
  await adapter(create).startTurn({
    ...input,
    signal: controller.signal,
    structuredOutput: {
      name: "result",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
    },
  });
  expect(create.mock.calls[0]![0].response_format).toMatchObject({
    type: "text",
    mime_type: "application/json",
    schema: { type: "object" },
  });
  expect(create.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  const denied = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("Access required"), { status: 402 }),
    );
  await expect(adapter(denied).startTurn(input)).rejects.toMatchObject({
    status: 402,
  });
  expect(denied).toHaveBeenCalledTimes(1);
});

it("rejects mixed interaction streams and invalid usage counters", async () => {
  async function* stream(): AsyncGenerator<Interactions.InteractionSSEEvent> {
    yield {
      event_type: "interaction.created",
      interaction: { id: "first", status: "in_progress" },
    };
    yield {
      event_type: "interaction.completed",
      interaction: { id: "different", status: "completed", steps: [] },
    };
  }
  await expect(
    adapter(vi.fn().mockResolvedValue(stream())).startTurn({
      ...input,
      onStreamEvent: () => {},
    }),
  ).rejects.toThrow("changed interaction identity");
  expect(
    normalizeInteractionUsage({
      total_tokens: -1,
      total_input_tokens: Number.NaN,
      total_output_tokens: 4,
    }),
  ).toEqual({ outputTokens: 4 });
  expect(
    normalizeInteractionUsage({ total_tokens: Number.POSITIVE_INFINITY }),
  ).toBeUndefined();
});
