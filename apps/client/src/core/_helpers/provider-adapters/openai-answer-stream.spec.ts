import { describe, it, expect } from "vitest";
import { OpenAIFinalAnswerStream } from "./openai-answer-stream.js";

function start() {
  const stream = new OpenAIFinalAnswerStream();
  stream.consume({
    type: "response.created",
    sequence_number: 0,
    response: { id: "response" },
  });
  return stream;
}
const message = (id: string, phase?: string) => ({
  id,
  type: "message",
  role: "assistant",
  phase,
  status: "in_progress",
  content: [],
});
const delta = (item_id: string, sequence_number: number, delta: string) => ({
  type: "response.output_text.delta",
  item_id,
  sequence_number,
  delta,
  content_index: 0,
});

describe("explicit OpenAI final answer boundary", () => {
  it("excludes commentary, unmarked text, reasoning, tools and child agents", () => {
    const stream = start();
    for (const [index, item] of [
      message("commentary", "commentary"),
      message("unmarked"),
      { ...message("child", "final_answer"), agent: { agent_name: "/worker" } },
      { id: "tool", type: "function_call", phase: "final_answer" },
      { id: "reasoning", type: "reasoning", phase: "final_answer" },
    ].entries()) {
      expect(
        stream.consume({
          type: "response.output_item.added",
          sequence_number: index * 2 + 1,
          item,
        }),
      ).toEqual([]);
      expect(
        stream.consume(
          delta(String(item.id), index * 2 + 2, "Never speak this."),
        ),
      ).toEqual([]);
    }
  });
  it("emits only verified final text, preserves fragmented markup, and ignores duplicate/reordered events", () => {
    const stream = start();
    expect(
      stream.consume({
        type: "response.output_item.added",
        sequence_number: 1,
        item: message("answer", "final_answer"),
      }),
    ).toMatchObject([
      { text: "", channel: "final_answer", status: "streaming" },
    ]);
    expect(stream.consume(delta("answer", 2, "Hello [cal"))).toMatchObject([
      { text: "Hello [cal" },
    ]);
    expect(stream.consume(delta("answer", 2, "duplicate"))).toEqual([]);
    stream.consume({
      type: "response.created",
      sequence_number: 0,
      response: { id: "response" },
    });
    expect(stream.consume(delta("answer", 1, "old"))).toEqual([]);
    expect(stream.consume(delta("answer", 3, "m] world."))).toMatchObject([
      { text: "Hello [calm] world." },
    ]);
    expect(
      stream.consume({
        type: "response.output_item.done",
        sequence_number: 4,
        item: {
          ...message("answer", "final_answer"),
          status: "completed",
          content: [{ type: "output_text", text: "Hello [calm] world." }],
        },
      }),
    ).toMatchObject([{ status: "completed", text: "Hello [calm] world." }]);
  });
  it("waits for phase when it only arrives at completion and reports channel replacement", () => {
    const stream = start();
    stream.consume({
      type: "response.output_item.added",
      sequence_number: 1,
      item: message("answer"),
    });
    expect(
      stream.consume(delta("answer", 2, "Deferred until classified.")),
    ).toEqual([]);
    expect(
      stream.consume({
        type: "response.output_item.done",
        sequence_number: 3,
        item: { ...message("answer", "final_answer"), status: "completed" },
      }),
    ).toMatchObject([
      { text: "Deferred until classified.", status: "completed" },
    ]);
    expect(
      stream.consume({
        type: "response.output_item.done",
        sequence_number: 4,
        item: { ...message("answer", "commentary"), status: "completed" },
      }),
    ).toMatchObject([{ status: "retracted" }]);
  });
  it("retracts interrupted or replaced answers and fails closed on missing completion", () => {
    for (const type of [
      "response.failed",
      "response.incomplete",
      "response.completed",
      "error",
    ]) {
      const stream = start();
      stream.consume({
        type: "response.output_item.added",
        sequence_number: 1,
        item: message("answer", "final_answer"),
      });
      stream.consume(delta("answer", 2, "Partial."));
      expect(
        stream.consume({
          type,
          sequence_number: 3,
          response: { id: "response" },
        }),
      ).toMatchObject([{ status: "retracted" }]);
    }
    const stream = start();
    stream.consume({
      type: "response.output_item.added",
      sequence_number: 1,
      item: message("answer", "final_answer"),
    });
    expect(
      stream.consume({
        type: "response.created",
        sequence_number: 0,
        response: { id: "replacement" },
      }),
    ).toMatchObject([{ responseId: "response", status: "retracted" }]);
  });
  it("bounds UTF-8 bytes rather than characters and never publishes oversized text", () => {
    const stream = start();
    stream.consume({
      type: "response.output_item.added",
      sequence_number: 1,
      item: message("answer", "final_answer"),
    });
    const update = stream.consume(delta("answer", 2, "界".repeat(400_000)));
    expect(update).toMatchObject([{ status: "limited", text: "" }]);
    expect(stream.consume(delta("answer", 3, "late"))).toEqual([]);
  });
});
