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
});
