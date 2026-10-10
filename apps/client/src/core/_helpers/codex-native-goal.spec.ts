import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import { CodexNativeGoalDecoder } from "./codex-native-goal.js";
import type { ExternalAgentCliOutputUpdate } from "./external-agent-cli-output.js";

let decoder: CodexNativeGoalDecoder;
let messages: Array<Record<string, unknown>>;
let close: ReturnType<typeof vi.fn<() => void>>;
const send = (event: Record<string, unknown>): ExternalAgentCliOutputUpdate =>
  decoder.push(`${JSON.stringify(event)}\n`);
const startGoal = (): void => {
  decoder.start();
  send({ id: 1, result: {} });
  send({ id: 2, result: { thread: { id: "thread-1" } } });
  send({ id: 3, result: { goal: { status: "paused" } } });
  send({ id: 4, result: { turn: { id: "turn-1" } } });
  send({ id: 5, result: { goal: { status: "active" } } });
};

beforeEach(async () => {
  const config = await loadRuntimeConfig(process.cwd());
  messages = [];
  close = vi.fn();
  decoder = new CodexNativeGoalDecoder(
    {
      objective: "Verify intake",
      prompt: "User steering and the full conversation",
      imagePaths: ["food.png"],
    },
    { ...config, model: "gpt-5.5" },
    (message) => {
      messages.push(JSON.parse(message) as Record<string, unknown>);
    },
    close,
    true,
  );
});

describe("native Codex goals", () => {
  const completeGoal = (): ExternalAgentCliOutputUpdate => {
    send({
      method: "thread/goal/updated",
      params: { threadId: "thread-1", goal: { status: "complete" } },
    });
    return send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
  };

  it("creates a provider goal and supplies context before enabling continuation", () => {
    startGoal();
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "thread/goal/set",
      "turn/start",
      "thread/goal/set",
    ]);
    expect(messages[2]?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: false,
      allowProviderModelFallback: false,
    });
    expect(messages[3]?.params).toEqual({
      threadId: "thread-1",
      objective: "Verify intake",
      status: "paused",
    });
    expect(messages[4]?.params).toMatchObject({
      input: [
        { type: "text", text: "User steering and the full conversation" },
        { type: "localImage", path: "food.png" },
      ],
    });
    expect(messages[5]?.params).toEqual({
      threadId: "thread-1",
      status: "active",
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("waits through provider continuation and preserves final output, evidence and cumulative usage", () => {
    startGoal();
    send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "tool-1",
          type: "commandExecution",
          aggregatedOutput: "All intake tests pass",
          exitCode: 0,
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    expect(decoder.hasTerminalResult()).toBe(false);
    expect(close).not.toHaveBeenCalled();
    send({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2" } },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          total: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cachedInputTokens: 30,
            reasoningOutputTokens: 5,
          },
        },
      },
    });
    send({
      method: "thread/goal/updated",
      params: { threadId: "thread-1", goal: { status: "complete" } },
    });
    expect(close).not.toHaveBeenCalled();
    send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "answer",
          type: "agentMessage",
          text: "Every intake requirement is verified.",
        },
      },
    });
    expect(
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-2", status: "completed" },
        },
      }).resultExitCode,
    ).toBe(0);
    expect(decoder.getFinalOutput()).toBe(
      "Every intake requirement is verified.",
    );
    expect(decoder.getToolCallCount()).toBe(1);
    expect(decoder.getToolEvidence()).toContain("All intake tests pass");
    expect(decoder.getModelCallCount()).toBe(2);
    expect(decoder.getUsage()).toMatchObject({
      totalTokens: 120,
      cachedInputTokens: 30,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not mistake the initial paused goal for a terminal result", () => {
    decoder.start();
    send({ id: 1, result: {} });
    send({ id: 2, result: { thread: { id: "thread-1" } } });
    send({ id: 3, result: { goal: { status: "paused" } } });
    send({ id: 4, result: { turn: { id: "turn-1" } } });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    expect(decoder.hasTerminalResult()).toBe(false);
    send({ id: 5, result: { goal: { status: "active" } } });
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["blocked", "paused", "usageLimited", "budgetLimited"])(
    "settles native %s after the final turn",
    (status) => {
      startGoal();
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        },
      });
      expect(
        send({
          method: "thread/goal/updated",
          params: { threadId: "thread-1", goal: { status } },
        }).resultExitCode,
      ).toBe(0);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("pauses the provider goal and interrupts its active turn on cancellation", () => {
    startGoal();
    decoder.interrupt();
    expect(messages.at(-2)).toMatchObject({
      method: "thread/goal/set",
      params: { status: "paused" },
    });
    expect(messages.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("keeps a newer goal notification when an activation response arrives late", () => {
    decoder.start();
    send({ id: 1, result: {} });
    send({ id: 2, result: { thread: { id: "thread-1" } } });
    send({ id: 3, result: { goal: { status: "paused" } } });
    send({ id: 4, result: { turn: { id: "turn-1" } } });
    send({
      method: "thread/goal/updated",
      params: { threadId: "thread-1", goal: { status: "complete" } },
    });
    send({ id: 5, result: { goal: { status: "active" } } });
    expect(close).not.toHaveBeenCalled();
    expect(
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        },
      }).resultExitCode,
    ).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not reopen a turn when its start response arrives after completion", () => {
    decoder.start();
    send({ id: 1, result: {} });
    send({ id: 2, result: { thread: { id: "thread-1" } } });
    send({ id: 3, result: { goal: { status: "paused" } } });
    send({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    send({ id: 4, result: { turn: { id: "turn-1" } } });
    send({ id: 5, result: { goal: { status: "active" } } });
    expect(
      send({
        method: "thread/goal/updated",
        params: { threadId: "thread-1", goal: { status: "complete" } },
      }).resultExitCode,
    ).toBe(0);
    expect(decoder.getModelCallCount()).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an unknown goal status instead of treating it as completed", () => {
    startGoal();
    expect(
      send({
        method: "thread/goal/updated",
        params: { threadId: "thread-1", goal: { status: "invalid" } },
      }).resultExitCode,
    ).toBe(1);
    expect(decoder.getFailureMessage()).toContain("invalid goal status");
  });

  it("fails explicitly when the CLI does not implement the goal API", () => {
    startGoal();
    expect(
      send({
        id: 5,
        error: { code: -32601, message: "Unknown method thread/goal/set" },
      }).resultExitCode,
    ).toBe(1);
    expect(decoder.getFailureMessage()).toContain(
      "Unknown method thread/goal/set",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects invalid protocol and premature process exit", () => {
    expect(decoder.finish().resultExitCode).toBe(1);
    expect(decoder.getFailureMessage()).toContain("before its native goal");
  });

  it("handles partial JSON and ignores notifications from other threads", () => {
    startGoal();
    decoder.push('{"method":"thread/goal/updated",');
    decoder.push(
      '"params":{"threadId":"other-thread","goal":{"status":"complete"}}}\n',
    );
    expect(decoder.hasTerminalResult()).toBe(false);
    expect(decoder.push("invalid json\n").resultExitCode).toBe(1);
  });

  it.each([32_767, 4_000_000])(
    "continues after oversized tool output delivered in %s-character chunks",
    (chunkSize) => {
      startGoal();
      const source = `${JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          item: {
            id: "large-tool",
            type: "commandExecution",
            aggregatedOutput: "x".repeat(2_100_000) + "\nAll tests passed.",
            exitCode: 0,
          },
        },
      })}\n`;
      for (let offset = 0; offset < source.length; offset += chunkSize)
        expect(
          decoder.push(source.slice(offset, offset + chunkSize)).resultExitCode,
        ).toBeUndefined();
      expect(decoder.getToolCallCount()).toBe(1);
      expect(decoder.getToolEvidence()).toContain("All tests passed.");
      expect(decoder.getToolEvidence()).toContain('"outputTruncated":true');
      expect(decoder.getToolEvidence().length).toBeLessThanOrEqual(32_000);
      expect(completeGoal().resultExitCode).toBe(0);
      expect(decoder.getFailureMessage()).toBeUndefined();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("processes batches larger than the old message limit without a cumulative output limit", () => {
    startGoal();
    const source = Array.from(
      { length: 1_100 },
      (_, index) =>
        JSON.stringify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: {
              id: String(index),
              type: "commandExecution",
              aggregatedOutput: "x".repeat(2_000),
              exitCode: 0,
            },
          },
        }) + "\n",
    ).join("");
    expect(source.length).toBeGreaterThan(2_000_000);
    expect(decoder.push(source).resultExitCode).toBeUndefined();
    expect(decoder.getToolCallCount()).toBe(1_100);
    expect(decoder.getToolEvidence().length).toBeLessThanOrEqual(32_000);
    expect(completeGoal().resultExitCode).toBe(0);
  });

  it.each(["x", "\u0000"])(
    "bounds oversized assistant output without blocking completion (%j)",
    (character) => {
      startGoal();
      const update = send({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          item: {
            id: "answer",
            type: "agentMessage",
            text: character.repeat(2_100_000) + "Final verification passed.",
          },
        },
      });
      expect(update.displayText.join("").length).toBeLessThan(512_000);
      expect(decoder.getFinalOutput()).toContain("Final verification passed.");
      expect(completeGoal().resultExitCode).toBe(0);
    },
  );

  it("preserves a terminal result when large or malformed data arrives later", () => {
    startGoal();
    expect(completeGoal().resultExitCode).toBe(0);
    expect(decoder.push("x".repeat(2_100_000) + "\n")).toEqual({
      displayText: [],
    });
    expect(decoder.finish().resultExitCode).toBeUndefined();
    expect(decoder.getFailureMessage()).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps output already decoded when a later message is malformed", () => {
    startGoal();
    const source =
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          item: { id: "answer", type: "agentMessage", text: "Work is saved." },
        },
      }) + "\ninvalid\n";
    expect(decoder.push(source)).toMatchObject({
      displayText: ["Work is saved.\n\n"],
      resultExitCode: 1,
    });
    expect(decoder.getFailureMessage()).toContain("invalid goal protocol");
    expect(decoder.push("x".repeat(2_100_000))).toEqual({ displayText: [] });
    expect(decoder.getFailureMessage()).toContain("invalid goal protocol");
    expect(close).toHaveBeenCalledOnce();
  });

  it("decodes a final control message without a trailing newline at EOF", () => {
    startGoal();
    send({
      method: "thread/goal/updated",
      params: { threadId: "thread-1", goal: { status: "complete" } },
    });
    decoder.push(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        },
      }),
    );
    expect(decoder.finish().resultExitCode).toBe(0);
    expect(decoder.getFailureMessage()).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails once when a process exits midway through a protocol message", () => {
    startGoal();
    decoder.push('{"method":"turn/completed","params":');
    expect(decoder.finish().resultExitCode).toBe(1);
    expect(decoder.getFailureMessage()).toContain("invalid goal protocol");
    expect(decoder.finish().resultExitCode).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
