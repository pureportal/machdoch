import type OpenAI from "openai";
import { describe, it, expect, vi } from "vitest";
import type { AgentModelStreamEvent } from "../../types.js";
import { OpenAIResponsesAdapter } from "./openai-adapter.js";

describe("OpenAI adapter final channel", () => {
  it("publishes the explicit final stream before the response completes and never relabels drafts or children", async () => {
    const events: AgentModelStreamEvent[] = [];
    let send: (value: unknown) => void = () => {
      throw new Error("The SDK event callback is missing.");
    };
    const item = {
      id: "answer",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      status: "in_progress",
      content: [],
    };
    const stream = {
      abort: vi.fn(),
      on: vi.fn((_name: string, callback: (value: unknown) => void) => {
        send = callback;
      }),
      finalResponse: async () => {
        send({
          type: "response.created",
          sequence_number: 0,
          response: { id: "response" },
        });
        send({
          type: "response.output_item.added",
          sequence_number: 1,
          item: { ...item, id: "draft", phase: "commentary" },
        });
        send({
          type: "response.output_text.delta",
          sequence_number: 2,
          item_id: "draft",
          content_index: 0,
          delta: "Private progress.",
        });
        send({
          type: "response.output_item.added",
          sequence_number: 3,
          item: { ...item, id: "child", agent: { agent_name: "/worker" } },
        });
        send({
          type: "response.output_text.delta",
          sequence_number: 4,
          item_id: "child",
          content_index: 0,
          delta: "Worker text.",
        });
        send({ type: "response.output_item.added", sequence_number: 5, item });
        send({
          type: "response.output_text.delta",
          sequence_number: 6,
          item_id: "answer",
          content_index: 0,
          delta: "Final answer.",
        });
        const updates = events.filter((event) => event.type === "final-answer");
        expect(updates).toHaveLength(2);
        expect(updates.at(-1)).toMatchObject({
          snapshot: {
            text: "Final answer.",
            status: "streaming",
            source: "openai-responses",
            channel: "final_answer",
          },
        });
        const completed = {
          ...item,
          status: "completed",
          content: [{ type: "output_text", text: "Final answer." }],
        };
        send({
          type: "response.output_item.done",
          sequence_number: 7,
          item: completed,
        });
        return { id: "response", output: [completed] };
      },
    };
    const client = {
      responses: { stream: vi.fn(() => stream) },
    } as unknown as OpenAI;
    const adapter = new OpenAIResponsesAdapter(client, []);
    const turn = await adapter.startTurn({
      model: "gpt-5.4",
      systemPrompt: "System",
      userPrompt: "User",
      tools: [],
      onStreamEvent: (event) => events.push(event),
    });
    expect(turn.text).toBe("Final answer.");
    expect(
      events
        .filter((event) => event.type === "final-answer")
        .map((event) => event.snapshot.text),
    ).toEqual(["", "Final answer.", "Final answer."]);
  });
});
