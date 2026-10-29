import type { AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLiveTracker } from "./agent-live-tracker.js";
import { AgentControlRequestError, startAgentTaskControlServer } from "./agent-task-control-server.js";
import { extractFollowUpSuggestions, hideFollowUpBlock, mergeFollowUpSuggestions } from "./follow-up-suggestions.js";
import { registerRunCancellation, requestRunCancellation } from "./run-cancellation.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentLiveTracker", () => {
  const createTracker = (states: AgentLiveState[]) =>
    new AgentLiveTracker({ provider: "claude-cli", transport: "stream-json", capabilities: ["steer"] }, (state) => states.push(state), 200);

  it("publishes the opening state on the first flush", () => {
    const states: AgentLiveState[] = [];
    createTracker(states).flush();
    expect(states).toEqual([{ provider: "claude-cli", transport: "stream-json", capabilities: ["steer"] }]);
  });

  it("coalesces bursts into one throttled snapshot and skips unchanged updates", () => {
    vi.useFakeTimers();
    const states: AgentLiveState[] = [];
    const tracker = createTracker(states);
    tracker.flush();
    for (let index = 0; index < 50; index += 1) tracker.setUsage({ inputTokens: index });
    expect(states).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(states).toHaveLength(2);
    expect(states[1]?.usage).toEqual({ inputTokens: 49 });

    tracker.setUsage({ inputTokens: 49 });
    vi.advanceTimersByTime(250);
    expect(states).toHaveLength(2);
    tracker.close();
  });

  it("keeps lists bounded and settles tasks that left the running set", () => {
    const states: AgentLiveState[] = [];
    const tracker = createTracker(states);
    for (let index = 0; index < 80; index += 1) {
      tracker.upsertTask({ id: `task-${index}`, kind: "shell", description: `Task ${index}`, status: "running", canStop: true });
    }
    for (let index = 0; index < 30; index += 1) tracker.addNotice("info", `Notice ${index}`);
    tracker.replaceRunningTasks(new Set(["task-79"]));
    const snapshot = tracker.snapshot();
    expect(snapshot.tasks).toHaveLength(60);
    expect(snapshot.tasks?.filter((task) => task.status === "running").map((task) => task.id)).toEqual(["task-79"]);
    expect(snapshot.tasks?.find((task) => task.id === "task-50")).toMatchObject({ status: "completed", canStop: false });
    expect(snapshot.notices).toHaveLength(20);
    tracker.close();
  });

  it("clips oversized provider questions and keeps usage counts whole", () => {
    const states: AgentLiveState[] = [];
    const tracker = createTracker(states);
    tracker.setQuestion({
      id: "q",
      status: "pending",
      items: [{ id: "a", question: "x".repeat(3_000), header: "h".repeat(200), options: Array.from({ length: 20 }, (_, index) => ({ label: `o${index}` })) }],
    });
    tracker.setUsage({ inputTokens: 10.6, outputTokens: -3, costUsd: 0.125 });
    tracker.flush();
    const last = states.at(-1);
    expect(last?.question?.items[0]?.question).toHaveLength(2_000);
    expect(last?.question?.items[0]?.header).toHaveLength(120);
    expect(last?.question?.items[0]?.options).toHaveLength(12);
    expect(last?.usage).toEqual({ inputTokens: 11, outputTokens: 0, costUsd: 0.125 });
    tracker.close();
  });

  it("confirms and fails steering messages", () => {
    const tracker = createTracker([]);
    tracker.recordSteer("s1", "First", "pending");
    tracker.recordSteer("s2", "Second", "pending");
    expect(tracker.confirmSteer("Second")).toBe(true);
    expect(tracker.confirmSteer("Unknown")).toBe(false);
    tracker.failPendingSteers("Turn over.");
    expect(tracker.snapshot().steering).toEqual([
      { id: "s1", text: "First", status: "failed", error: "Turn over." },
      { id: "s2", text: "Second", status: "delivered" },
    ]);
    tracker.close();
  });

  it("publishes questions and steering at once and stops after close", () => {
    const states: AgentLiveState[] = [];
    const tracker = createTracker(states);
    tracker.setQuestion({ id: "q", status: "pending", items: [{ id: "a", question: "Why?", options: [] }] });
    tracker.recordSteer("s1", "Faster", "pending");
    expect(states.map((state) => [state.question?.status, state.steering?.length])).toEqual([
      ["pending", undefined],
      ["pending", 1],
    ]);
    tracker.close();
    tracker.setUsage({ inputTokens: 1 });
    tracker.flush();
    expect(states).toHaveLength(2);
  });
});

describe("startAgentTaskControlServer", () => {
  it("requires the run token, routes requests and reports handler errors", async () => {
    const steer = vi.fn();
    const answer = vi.fn(() => {
      throw new AgentControlRequestError("This question is no longer waiting for an answer.");
    });
    const server = await startAgentTaskControlServer({ steer, answer });
    try {
      const { url, token, capabilities } = server.endpoint;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(capabilities).toEqual(["steer", "answer"]);
      const post = (path: string, body: unknown, auth = token) =>
        fetch(`${url}${path}`, { method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

      expect((await post("/v1/steer", { text: "hi" }, "wrong-token")).status).toBe(401);
      expect((await post("/v1/steer", { text: "  Use tabs.  " })).status).toBe(200);
      expect(steer).toHaveBeenCalledWith("Use tabs.");
      expect((await post("/v1/steer", { text: "   " })).status).toBe(400);
      const conflict = await post("/v1/answer", { questionId: "q", answers: { a: "yes" } });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: "This question is no longer waiting for an answer." });
      expect((await post("/v1/interrupt", {})).status).toBe(409);
      expect((await post("/v1/nowhere", {})).status).toBe(404);
      expect((await post("/v1/steer", { text: "x".repeat(70 * 1024) })).status).toBe(413);

      const preflight = await fetch(`${url}/v1/steer`, { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
      expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
    } finally {
      await server.close();
    }
  });
});

describe("follow-up suggestions", () => {
  const block = "<machdoch-follow-ups>\n- Add tests for the parser\n- 2) \"Explain the change\"\n- add tests for the parser\n</machdoch-follow-ups>";

  it("takes a trailing block off the answer", () => {
    expect(extractFollowUpSuggestions(`Done.\n\n${block}\n`)).toEqual({
      text: "Done.",
      suggestions: ["Add tests for the parser", "Explain the change"],
    });
  });

  it("leaves a block that is followed by more text in the answer", () => {
    const text = `Example:\n${block}\nThat is the format.`;
    expect(extractFollowUpSuggestions(text)).toEqual({ text, suggestions: [] });
  });

  it("hides a block while it streams in", () => {
    expect(hideFollowUpBlock("Done.\n<machdoch-fol")).toBe("Done.\n");
    expect(hideFollowUpBlock(`Done.\n${block.slice(0, 40)}`)).toBe("Done.");
  });

  it("merges sources without duplicates and keeps three", () => {
    expect(mergeFollowUpSuggestions(["Add tests", "Ship it"], ["add tests", "Write docs", "Refactor"])).toEqual([
      "Add tests",
      "Ship it",
      "Write docs",
    ]);
  });
});

describe("run cancellation", () => {
  it("cancels the run that owns a signal once", () => {
    const controller = new AbortController();
    const cancel = vi.fn((reason: string) => controller.abort(reason));
    registerRunCancellation(controller.signal, cancel);
    expect(requestRunCancellation(controller.signal, "Stop")).toBe(true);
    expect(cancel).toHaveBeenCalledWith("Stop");
    expect(requestRunCancellation(controller.signal, "Again")).toBe(false);
    expect(requestRunCancellation(new AbortController().signal, "Unknown")).toBe(false);
    expect(requestRunCancellation(undefined, "None")).toBe(false);
  });
});
