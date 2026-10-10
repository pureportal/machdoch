import { describe, expect, it } from "vitest";
import { CodexGoalProtocolReader } from "./codex-goal-protocol.js";
import { hasUnpairedUtf16Surrogate } from "@machdoch/fleet-protocol/unicode";

const read = (
  source: string,
  chunkSize = source.length,
): Record<string, unknown>[] => {
  const reader = new CodexGoalProtocolReader();
  const events: Record<string, unknown>[] = [];
  const onEvent = (event: Record<string, unknown>) => {
    events.push(event);
    return true;
  };
  for (let offset = 0; offset < source.length; offset += chunkSize)
    reader.push(source.slice(offset, offset + chunkSize), onEvent);
  reader.finish(onEvent);
  return events;
};

describe("Codex goal protocol reader", () => {
  it.each([1, 7, 16_384, 1_000_000])(
    "preserves JSON scalars and escapes across %s-character chunks",
    (chunkSize) => {
      const event = {
        id: 12,
        method: "item/completed",
        params: {
          threadId: "thread-1",
          item: {
            id: "tool-1",
            type: "commandExecution",
            aggregatedOutput: 'Quote: " Backslash: \\ Newline: \n Emoji: 🌿',
            exitCode: -1,
            result: {
              success: false,
              count: 1.25e-9,
              empty: null,
              content: [true, "hello", {}],
            },
          },
        },
      };
      expect(read(`\r\n${JSON.stringify(event)}\r\n`, chunkSize)).toEqual([
        event,
      ]);
    },
  );

  it("discards repeated history without losing control fields that follow it", () => {
    const history = Array.from({ length: 20_000 }, (_, index) => ({
      id: String(index),
      text: "x".repeat(150),
    }));
    const source = JSON.stringify({
      params: {
        turn: {
          items: history,
          error: { message: "Verification failed." },
          status: "failed",
          id: "turn-1",
        },
        threadId: "thread-1",
      },
      method: "turn/completed",
    });
    expect(source.length).toBeGreaterThan(2_000_000);
    expect(read(source, 32_768)).toEqual([
      {
        params: {
          turn: {
            error: { message: "Verification failed." },
            status: "failed",
            id: "turn-1",
          },
          threadId: "thread-1",
        },
        method: "turn/completed",
      },
    ]);
  });

  it("bounds large tool strings and arrays while preserving tool metadata", () => {
    const source = JSON.stringify({
      method: "item/completed",
      params: {
        item: {
          result: {
            content: [{ type: "image", data: "x".repeat(3_000_000) }],
            rows: Array.from({ length: 30_000 }, () => ({
              text: "Long tool output",
            })),
          },
          aggregatedOutput:
            "Test started.\n" + "🌿".repeat(1_100_000) + "\nTwo tests failed.",
          type: "commandExecution",
          id: "tool-1",
          exitCode: 1,
        },
        threadId: "thread-1",
      },
    });
    const [event] = read(source, 16_381);
    expect(event).toMatchObject({
      params: {
        item: {
          id: "tool-1",
          type: "commandExecution",
          exitCode: 1,
          outputTruncated: true,
        },
      },
    });
    const output = JSON.stringify(event);
    expect(output.length).toBeLessThan(30_000);
    expect(output).toContain("Test started.");
    expect(output).toContain("Two tests failed.");
    expect(output).toContain("output truncated by machdoch");
    const item = (event!.params as Record<string, unknown>).item as Record<
      string,
      unknown
    >;
    expect(hasUnpairedUtf16Surrogate(String(item.aggregatedOutput))).toBe(
      false,
    );
  });

  it("keeps prototype-shaped payload keys as ordinary data", () => {
    const source =
      '{"params":{"item":{"result":{"__proto__":{"polluted":true},"constructor":false}}}}';
    const [event] = read(source);
    const result = (
      (event!.params as Record<string, unknown>).item as Record<string, unknown>
    ).result as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect({}).not.toHaveProperty("polluted");
  });

  it.each([
    '{"params":{"ignored":[1,]}}\n',
    '{"params":{"ignored":"bad\\q"}}\n',
    '{"params":{"ignored":"unterminated',
    '{"method":"turn/completed"} trailing\n',
    '{"method":"turn/completed"}{"method":"error"}\n',
    "[]\n",
    "null\n",
    '{}\n{"params":',
  ])("rejects invalid data, including discarded payloads: %s", (source) => {
    expect(() => read(source, 7)).toThrow();
  });

  it("rejects excessive nesting and oversized control values", () => {
    expect(() =>
      read('{"ignored":' + "[".repeat(65) + "0" + "]".repeat(65) + "}"),
    ).toThrow("nesting");
    expect(() => read(JSON.stringify({ method: "x".repeat(9_000) }))).toThrow(
      "control value",
    );
    expect(() => read(JSON.stringify({ ["x".repeat(1_000)]: true }))).toThrow(
      "control value",
    );
  });
});
