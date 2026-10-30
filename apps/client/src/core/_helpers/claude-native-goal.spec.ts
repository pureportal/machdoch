import { afterEach, describe, expect, it } from "vitest";
import { ClaudeNativeGoalSession } from "./claude-native-goal.js";

let session: ClaudeNativeGoalSession;

const start = () => {
  const written: string[] = [];
  let closed = false;
  session = new ClaudeNativeGoalSession(
    "All auth tests pass",
    {
      write: (message) => written.push(message),
      closeInput: () => {
        closed = true;
      },
    },
    () => undefined,
    { model: "claude-opus-5-5", captureEvidence: true },
  );
  session.start();
  return { written, isClosed: () => closed };
};

const receive = (event: Record<string, unknown>) =>
  session.push(`${JSON.stringify(event)}\n`);

afterEach(() => session.dispose());

describe("ClaudeNativeGoalSession", () => {
  it("sends the goal once and offers no live controls", () => {
    const { written, isClosed } = start();
    expect(written).toEqual(["/goal All auth tests pass"]);
    expect(isClosed()).toBe(true);
    expect(session.interrupt()).toBe(false);
    expect(session.live.snapshot()).toMatchObject({
      provider: "claude-cli",
      transport: "stream-json",
      capabilities: [],
      model: "claude-opus-5-5",
    });
  });

  it("reports plan limits, plan, files and usage from the goal's event stream", () => {
    start();
    receive({
      type: "assistant",
      message: {
        id: "message-1",
        usage: { input_tokens: 40, cache_read_input_tokens: 60 },
        content: [
          {
            type: "tool_use",
            id: "plan",
            name: "TodoWrite",
            input: {
              todos: [{ content: "Run auth tests", status: "in_progress" }],
            },
          },
          {
            type: "tool_use",
            id: "edit",
            name: "Edit",
            input: { file_path: "src/auth.ts" },
          },
        ],
      },
    });
    receive({
      type: "system",
      subtype: "task_started",
      task_id: "cargo",
      task_type: "local_bash",
      description: "Run cargo test",
    });
    receive({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: {
            utilization: 0.13,
            resetsAt: 1793362800,
            status: "allowed",
          },
          seven_day: { utilization: 0.27, status: "allowed" },
        },
      },
    });
    receive({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      result: "All auth tests pass.",
      total_cost_usd: 0.25,
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } },
    });

    expect(session.hasTerminalResult()).toBe(true);
    expect(session.getFinalOutput()).toBe("All auth tests pass.");
    expect(session.live.snapshot()).toMatchObject({
      plan: [{ text: "Run auth tests", status: "in_progress" }],
      fileChanges: [{ path: "src/auth.ts", kind: "update" }],
      tasks: [{ id: "cargo", kind: "shell", status: "running" }],
      limits: [
        { id: "five_hour", label: "5-hour limit", resetsAt: 1793362800000 },
        { id: "seven_day", label: "Weekly limit", usedPercent: 27 },
      ],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        contextUsedTokens: 100,
        contextWindowTokens: 1_000_000,
        costUsd: 0.25,
      },
    });
  });

  it("adds up usage across the results of a goal that waits for background work", () => {
    start();
    receive({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "cargo" }],
    });
    receive({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Still in progress.",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    receive({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    receive({
      type: "assistant",
      message: { id: "follow-up", content: [{ type: "text", text: "Passed." }] },
    });
    receive({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Passed.",
      usage: { input_tokens: 50, output_tokens: 5 },
    });

    expect(session.getFinalOutput()).toBe("Passed.");
    expect(session.live.snapshot().usage).toMatchObject({
      inputTokens: 150,
      outputTokens: 25,
    });
    expect(session.live.snapshot().tasks).toMatchObject([
      { id: "cargo", status: "completed" },
    ]);
  });
});
