import { describe, expect, it } from "vitest";
import {
  ClaudeCliOutputDecoder,
  CodexCliOutputDecoder,
} from "./external-agent-cli-output.js";

const eventLine = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value)}\n`;

describe("Codex CLI output decoder", () => {
  it("captures bounded tool results only when requested", () => {
    const decoder = new CodexCliOutputDecoder(true);
    const ordinary = new CodexCliOutputDecoder();
    const event = eventLine({
      type: "item.completed",
      item: {
        id: "command",
        type: "command_execution",
        command: "pnpm test",
        exit_code: 1,
        aggregated_output: "Two tests failed.",
      },
    });
    decoder.push(event);
    ordinary.push(event);
    expect(decoder.getToolEvidence()).toContain("Two tests failed.");
    expect(decoder.getToolEvidence()).toContain('"exit_code":1');
    expect(ordinary.getToolEvidence()).toBe("");
    for (let index = 0; index < 5; index++)
      decoder.push(
        eventLine({
          type: "item.completed",
          item: {
            id: String(index),
            type: "command_execution",
            aggregated_output: "x".repeat(20_000),
          },
        }),
      );
    expect(decoder.getToolEvidence().length).toBeLessThanOrEqual(32_000);
  });
  it("counts actual tools without treating final messages as progress", () => {
    const decoder = new CodexCliOutputDecoder();
    decoder.push(
      eventLine({
        type: "item.completed",
        item: { id: "message", type: "agent_message", text: "Still working." },
      }),
    );
    expect(decoder.getToolCallCount()).toBe(0);
    decoder.push(
      eventLine({
        type: "item.completed",
        item: { id: "command", type: "command_execution" },
      }),
    );
    decoder.push(
      eventLine({
        type: "item.completed",
        item: { id: "command", type: "command_execution" },
      }),
    );
    expect(decoder.getToolCallCount()).toBe(1);
  });
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

  it("waits for successful completion after reconnect diagnostics", () => {
    const decoder = new CodexCliOutputDecoder();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const update = decoder.push(
        eventLine({
          type: "error",
          message: `Reconnecting... ${attempt}/5 (stream disconnected before completion)`,
        }),
      );
      expect(update.resultExitCode).toBeUndefined();
      expect(decoder.hasTerminalResult()).toBe(false);
    }
    decoder.push(
      eventLine({
        type: "item.completed",
        item: { type: "agent_message", text: "Verified result." },
      }),
    );
    const update = decoder.push(eventLine({ type: "turn.completed" }));
    expect(update.resultExitCode).toBe(0);
    expect(decoder.hasTerminalResult()).toBe(true);
    expect(decoder.getFailureMessage()).toBeUndefined();
    expect(decoder.getFinalOutput()).toBe("Verified result.");
  });

  it("keeps a failed turn terminal even when answer text is available", () => {
    const decoder = new CodexCliOutputDecoder();
    decoder.push(
      eventLine({
        type: "item.completed",
        item: { type: "agent_message", text: "Partial result." },
      }),
    );
    decoder.push(eventLine({ type: "error", message: "Reconnecting... 4/5" }));
    const update = decoder.push(
      eventLine({
        type: "turn.failed",
        error: { message: "Retry limit exceeded." },
      }),
    );
    expect(update.resultExitCode).toBe(1);
    expect(decoder.hasTerminalResult()).toBe(true);
    expect(decoder.getFailureMessage()).toBe("Retry limit exceeded.");
    expect(
      decoder.push(eventLine({ type: "turn.completed" })).resultExitCode,
    ).toBeUndefined();
    expect(decoder.getFailureMessage()).toBe("Retry limit exceeded.");
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
  it("preserves tool-result evidence separately from assistant assertions", () => {
    const decoder = new ClaudeCliOutputDecoder(true);
    decoder.push(
      eventLine({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "test-1",
              content: "Two tests failed.",
              is_error: true,
            },
          ],
        },
      }),
    );
    decoder.push(
      eventLine({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "All tests passed." }],
        },
      }),
    );
    expect(decoder.getToolEvidence()).toContain("Two tests failed.");
    expect(decoder.getToolEvidence()).not.toContain("All tests passed.");
    expect(decoder.getFinalOutput()).toBe("All tests passed.");
  });
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

  it("reports a turn-limit stop apart from a failure", () => {
    const decoder = new ClaudeCliOutputDecoder();
    const update = decoder.push(
      [
        eventLine({
          type: "assistant",
          message: {
            id: "message-1",
            content: [{ type: "text", text: "I'll build on it next." }],
          },
        }),
        eventLine({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          num_turns: 65,
          errors: [],
        }),
      ].join(""),
    );

    expect(update.resultExitCode).toBe(1);
    expect(decoder.reachedTurnLimit()).toBe(true);
    expect(decoder.getFailureMessage()).toBeUndefined();
    expect(decoder.getModelCallCount()).toBe(65);
    expect(decoder.getFinalOutput()).toBe("I'll build on it next.");
  });

  describe("while background jobs run on a goal turn", () => {
    const backgroundTasks = (count: number) =>
      eventLine({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: Array.from({ length: count }, (_, index) => ({
          task_id: `job-${index}`,
        })),
      });
    const result = (text: string, numTurns: number, inputTokens: number) =>
      eventLine({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: numTurns,
        result: text,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      });
    const assistant = (id: string, text: string) =>
      eventLine({
        type: "assistant",
        message: { id, content: [{ type: "text", text }] },
      });

    it("takes the follow-up turn's result as final and adds up usage", () => {
      const decoder = new ClaudeCliOutputDecoder(true, true);
      decoder.push(backgroundTasks(2));
      const waiting = decoder.push(result("Still in progress.", 5, 10));
      expect(waiting.displayText.at(-1)).toBe(
        "Waiting for 2 background jobs to finish.\n\n",
      );
      expect(decoder.hasTerminalResult()).toBe(true);
      expect(decoder.getCompletionGraceMs()).toBe(10 * 60 * 1_000);

      decoder.push(backgroundTasks(0));
      expect(decoder.getCompletionGraceMs()).toBe(2 * 60 * 1_000);

      decoder.push(assistant("message-2", "Both jobs passed."));
      expect(decoder.hasTerminalResult()).toBe(false);
      expect(decoder.getCompletionGraceMs()).toBeUndefined();

      const final = decoder.push(result("Both jobs passed.", 2, 20));
      expect(final.resultExitCode).toBe(0);
      expect(decoder.hasTerminalResult()).toBe(true);
      expect(decoder.getCompletionGraceMs()).toBeUndefined();
      expect(decoder.getFinalOutput()).toBe("Both jobs passed.");
      expect(decoder.getModelCallCount()).toBe(7);
      expect(decoder.getUsage()).toMatchObject({ inputTokens: 30 });
    });

    it("stops announcing the wait once its time is used up", () => {
      const decoder = new ClaudeCliOutputDecoder(true, true);
      decoder.push(backgroundTasks(1));
      decoder.push(result("Waiting on the build.", 1, 1));
      expect(decoder.takeBackgroundWaitNotice()).toBe(
        "Still waiting for 1 background job to finish.\n\n",
      );
      for (let step = 0; step < 4; step += 1) {
        expect(decoder.takeBackgroundWaitNotice()).toBeDefined();
      }
      expect(decoder.backgroundWaitExpired()).toBe(false);
      expect(decoder.takeBackgroundWaitNotice()).toBeUndefined();
      expect(decoder.backgroundWaitExpired()).toBe(true);
    });

    it("does not count a quiet follow-up after the jobs finish as an expired wait", () => {
      const decoder = new ClaudeCliOutputDecoder(true, true);
      decoder.push(backgroundTasks(1));
      decoder.push(result("Waiting on the build.", 1, 1));
      decoder.push(backgroundTasks(0));
      expect(decoder.takeBackgroundWaitNotice()).toBeUndefined();
      expect(decoder.backgroundWaitExpired()).toBe(false);
    });

    it("keeps the first result final outside goal turns", () => {
      const decoder = new ClaudeCliOutputDecoder();
      decoder.push(backgroundTasks(1));
      decoder.push(result("Done.", 1, 1));
      expect(decoder.getCompletionGraceMs()).toBeUndefined();
      decoder.push(assistant("message-2", "Late background note."));
      expect(decoder.hasTerminalResult()).toBe(true);
    });
  });

  it("explains an error result with the errors it lists", () => {
    const decoder = new ClaudeCliOutputDecoder();
    decoder.push(
      eventLine({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Tool runner crashed", " "],
      }),
    );

    expect(decoder.reachedTurnLimit()).toBe(false);
    expect(decoder.getFailureMessage()).toBe("Tool runner crashed");
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
