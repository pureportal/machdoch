import { describe, expect, it } from "vitest";
import {
  ClaudeCliOutputDecoder,
  CodexCliOutputDecoder,
} from "./external-agent-cli-output.js";

const eventLine = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value)}\n`;

describe("Codex CLI output decoder", () => {
  it("uses the terminal turn event for completion and token usage", () => {
    const decoder = new CodexCliOutputDecoder();
    const output = [
      eventLine({ type: "thread.started", thread_id: "thread-1" }),
      eventLine({ type: "turn.started" }),
      eventLine({
        type: "item.completed",
        item: { id: "item-1", type: "agent_message", text: "Done." },
      }),
      eventLine({
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 80,
          cache_write_input_tokens: 10,
          output_tokens: 30,
          reasoning_output_tokens: 12,
        },
      }),
    ].join("");
    const first = decoder.push(output.slice(0, 31));
    const second = decoder.push(output.slice(31));

    expect(first.resultExitCode).toBeUndefined();
    expect(second.resultExitCode).toBe(0);
    expect(decoder.hasTerminalResult()).toBe(true);
    expect(decoder.isModelCallCountReported()).toBe(false);
    expect(decoder.getFinalOutput()).toBe("Done.");
    expect(decoder.getUsage()).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      cachedInputTokens: 80,
      cacheReadInputTokens: 80,
      cacheWriteInputTokens: 10,
      reasoningTokens: 12,
    });
  });

  it("does not treat an item diagnostic as terminal after a successful turn", () => {
    const decoder = new CodexCliOutputDecoder();

    decoder.push(
      [
        eventLine({
          type: "item.completed",
          item: { type: "error", message: "stream lagged" },
        }),
        eventLine({
          type: "item.completed",
          item: { type: "agent_message", text: "Final answer." },
        }),
        eventLine({
          type: "turn.completed",
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      ].join(""),
    );

    expect(decoder.hasTerminalResult()).toBe(true);
    expect(decoder.getFinalOutput()).toBe("Final answer.");
  });
});

describe("Claude CLI output decoder", () => {
  it("captures retries, aggregate usage, turn count, and terminal result", () => {
    const decoder = new ClaudeCliOutputDecoder();
    const output = [
      eventLine({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 3,
      }),
      eventLine({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 4,
        result: "Claude completed the task.",
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 70,
          output_tokens: 15,
        },
      }),
    ].join("");
    const update = decoder.push(output);

    expect(update.resultExitCode).toBe(0);
    expect(decoder.getRetryCount()).toBe(1);
    expect(decoder.getModelCallCount()).toBe(4);
    expect(decoder.isModelCallCountReported()).toBe(true);
    expect(decoder.getFinalOutput()).toBe("Claude completed the task.");
    expect(decoder.getUsage()).toMatchObject({
      inputTokens: 100,
      outputTokens: 15,
      totalTokens: 115,
      cachedInputTokens: 70,
      cacheReadInputTokens: 70,
      cacheWriteInputTokens: 10,
    });
  });

  it("prefers validated structured output from the terminal result", () => {
    const decoder = new ClaudeCliOutputDecoder();
    const update = decoder.push(
      eventLine({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "The response text is not the structured value.",
        structured_output: {
          memories: [{ scope: "workspace", content: "Use pnpm." }],
        },
      }),
    );

    expect(update.resultExitCode).toBe(0);
    expect(JSON.parse(decoder.getFinalOutput())).toEqual({
      memories: [{ scope: "workspace", content: "Use pnpm." }],
    });
  });

  it("streams complete assistant messages but waits for the result event", () => {
    const decoder = new ClaudeCliOutputDecoder();
    const assistant = decoder.push(
      eventLine({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Working through the task." }],
        },
      }),
    );

    expect(assistant.displayText).toEqual(["Working through the task.\n\n"]);
    expect(assistant.resultExitCode).toBeUndefined();
    expect(decoder.hasTerminalResult()).toBe(false);

    const result = decoder.push(
      eventLine({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "Final answer.",
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    );

    expect(result.displayText).toEqual(["Final answer.\n\n"]);
    expect(result.resultExitCode).toBe(0);
  });

  it("reconstructs repeated assistant fragments when the terminal result is truncated", () => {
    const decoder = new ClaudeCliOutputDecoder();

    decoder.push(
      eventLine({
        type: "assistant",
        message: {
          id: "message-1",
          content: [{ type: "text", text: "Complete " }],
        },
      }),
    );
    const continuation = decoder.push(
      eventLine({
        type: "assistant",
        message: {
          id: "message-1",
          content: [{ type: "text", text: "answer." }],
        },
      }),
    );
    const result = decoder.push(
      eventLine({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Complete",
      }),
    );

    expect(continuation.displayText).toEqual(["answer.\n\n"]);
    expect(result.displayText).toEqual([]);
    expect(result.resultExitCode).toBe(0);
    expect(decoder.getFinalOutput()).toBe("Complete answer.");
  });

  it("ignores forwarded subagent text when choosing the top-level result", () => {
    const decoder = new ClaudeCliOutputDecoder();

    const assistant = decoder.push(
      eventLine({
        type: "assistant",
        parent_tool_use_id: "tool-1",
        message: {
          id: "subagent-message",
          content: [{ type: "text", text: "Subagent detail." }],
        },
      }),
    );
    decoder.push(
      eventLine({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Top-level answer.",
      }),
    );

    expect(assistant.displayText).toEqual(["Subagent detail.\n\n"]);
    expect(decoder.getFinalOutput()).toBe("Top-level answer.");
  });
});
