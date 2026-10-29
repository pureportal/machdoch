import type { AgentLiveState } from "@machdoch/fleet-protocol/task-thinking";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentLengthFrameReader,
  CopilotServerSession,
  encodeContentLengthFrame,
} from "./copilot-server-session.js";

type Message = Record<string, unknown> & { id?: number | string; method?: string; params?: Record<string, unknown> };

const SESSION_ID = "session-1";

const createHarness = (input: Partial<ConstructorParameters<typeof CopilotServerSession>[0]> = {}) => {
  const sent: Message[] = [];
  const reader = new ContentLengthFrameReader();
  const states: AgentLiveState[] = [];
  let closed = false;
  const session = new CopilotServerSession(
    {
      prompt: "Do the task.",
      imagePaths: [],
      session: { model: "claude-haiku-5.5", workingDirectory: "/repo" },
      skipCustomInstructions: true,
      ...input,
    },
    {
      write: (text) => reader.push(text, (body) => sent.push(JSON.parse(body) as Message)),
      closeInput: () => {
        closed = true;
      },
    },
    (state) => states.push(state),
    { model: "claude-haiku-5.5", captureEvidence: false },
  );
  const receive = (message: Record<string, unknown>) =>
    session.push(encodeContentLengthFrame({ jsonrpc: "2.0", ...message }));
  const last = (method: string) => [...sent].reverse().find((message) => message.method === method);
  const reply = (method: string, result: Record<string, unknown> = {}) =>
    receive({ id: last(method)?.id, result });
  const event = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    receive({ method: "session.event", params: { sessionId: SESSION_ID, event: { type, data, ...extra } } });
  /** Walks the handshake up to the prompt. */
  const open = () => {
    session.start();
    reply("connect", { ok: true, protocolVersion: 3 });
    reply("session.create", { sessionId: SESSION_ID });
    reply("session.permissions.setApproveAll", { success: true });
    reply("session.options.update", { success: true });
  };
  return { session, sent, states, receive, reply, event, open, last, isClosed: () => closed };
};

let disposeAll: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposeAll) dispose();
  disposeAll = [];
});

describe("ContentLengthFrameReader", () => {
  it("reassembles frames split mid-header and mid-character", () => {
    const frames = encodeContentLengthFrame({ text: "Grüße ✓" }) + encodeContentLengthFrame({ n: 2 });
    const bytes = Buffer.from(frames, "utf8");
    const bodies: string[] = [];
    const reader = new ContentLengthFrameReader();
    // Feed the stream as decoded text in small pieces, like a pipe would.
    const decoder = new TextDecoder();
    for (let offset = 0; offset < bytes.length; offset += 5) {
      reader.push(decoder.decode(bytes.subarray(offset, offset + 5), { stream: true }), (body) =>
        bodies.push(body),
      );
    }
    expect(bodies.map((body) => JSON.parse(body))).toEqual([{ text: "Grüße ✓" }, { n: 2 }]);
  });
});

describe("CopilotServerSession", () => {
  it("creates an approve-all session with the run-scoped agent before sending the prompt", () => {
    const harness = createHarness({
      session: {
        model: "claude-haiku-5.5",
        customAgents: [{ name: "machdoch-run", prompt: "Instructions" }],
        agent: "machdoch-run",
      },
      imagePaths: ["/tmp/shot.png"],
    });
    disposeAll.push(() => harness.session.dispose());
    harness.open();

    const create = harness.last("session.create")?.params ?? {};
    expect(create).toMatchObject({
      agent: "machdoch-run",
      requestUserInput: true,
      streaming: true,
      includeSubAgentStreamingEvents: true,
    });
    expect(harness.last("session.permissions.setApproveAll")?.params).toEqual({ sessionId: SESSION_ID, enabled: true });
    expect(harness.last("session.options.update")?.params).toEqual({ sessionId: SESSION_ID, skipCustomInstructions: true });
    expect(harness.last("session.send")?.params).toEqual({
      sessionId: SESSION_ID,
      prompt: "Do the task.",
      attachments: [{ type: "file", path: "/tmp/shot.png" }],
    });
  });

  it("finishes at assistant.idle, keeps the answer and shuts the server down", () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.open();
    harness.event("session.usage_info", { tokenLimit: 100_000, currentTokens: 25_000 }, { ephemeral: true });
    harness.event("assistant.usage", { inputTokens: 900, outputTokens: 40, cacheReadTokens: 300 }, { ephemeral: true });
    harness.event("assistant.message", { messageId: "m1", content: "All done.", toolRequests: [] });
    const update = harness.event("assistant.idle", {}, { ephemeral: true });

    expect(update.resultExitCode).toBe(0);
    expect(harness.session.getFinalOutput()).toBe("All done.");
    expect(harness.session.getUsage()).toMatchObject({ inputTokens: 900, outputTokens: 40, cachedInputTokens: 300 });
    expect(harness.last("session.destroy")?.params).toEqual({ sessionId: SESSION_ID });
    expect(harness.session.hasTerminalResult()).toBe(false);

    harness.reply("session.destroy", { success: true });
    expect(harness.last("runtime.shutdown")).toBeDefined();
    harness.reply("runtime.shutdown");
    expect(harness.isClosed()).toBe(true);
    expect(harness.session.hasTerminalResult()).toBe(true);
    expect(harness.session.live.snapshot()).toMatchObject({
      capabilities: [],
      usage: { contextUsedTokens: 25_000, contextWindowTokens: 100_000, inputTokens: 900 },
    });
  });

  it("shows ask_user as a question card and answers with the chosen option", () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.open();
    harness.receive({
      id: 7,
      method: "userInput.request",
      params: { sessionId: SESSION_ID, question: "Tea or coffee?", choices: ["Tea", "Coffee"], allowFreeform: true },
    });
    const question = harness.session.live.getQuestion();
    expect(question).toMatchObject({
      status: "pending",
      items: [{ id: "answer", question: "Tea or coffee?", options: [{ label: "Tea" }, { label: "Coffee" }], allowOther: true }],
    });

    harness.session.controls.answer?.(question!.id, { answer: "Coffee" });
    expect(harness.sent.find((message) => message.id === 7)).toMatchObject({ result: { answer: "Coffee", wasFreeform: false } });
    expect(harness.session.live.getQuestion()?.status).toBe("answered");
    expect(() => harness.session.controls.answer?.(question!.id, { answer: "Tea" })).toThrow("no longer waiting");
  });

  it("marks typed answers as freeform", () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.open();
    harness.receive({ id: 8, method: "userInput.request", params: { question: "Name?", choices: [] } });
    harness.session.controls.answer?.(harness.session.live.getQuestion()!.id, { answer: "Ada" });
    expect(harness.sent.find((message) => message.id === 8)).toMatchObject({ result: { answer: "Ada", wasFreeform: true } });
  });

  it("folds messages sent while Copilot starts into the prompt and steers later ones", () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.session.start();
    harness.reply("connect", { ok: true });
    harness.session.controls.steer?.("Also mention tests.");
    expect(harness.last("session.send")).toBeUndefined();

    harness.reply("session.create", { sessionId: SESSION_ID });
    harness.reply("session.permissions.setApproveAll", { success: true });
    harness.reply("session.options.update", { success: true });
    expect(harness.last("session.send")?.params).toMatchObject({ prompt: "Do the task.\n\nAlso mention tests." });
    expect(harness.session.live.snapshot().steering).toEqual([
      { id: "steer-1", text: "Also mention tests.", status: "delivered" },
    ]);

    harness.session.controls.steer?.("Keep it short.");
    expect(harness.last("session.send")?.params).toEqual({ sessionId: SESSION_ID, prompt: "Keep it short.", mode: "immediate" });
    harness.reply("session.send", { messageId: "m2" });
    // Accepted is not read: Copilot reports reading it with a steering user.message.
    expect(harness.session.live.snapshot().steering?.at(-1)).toMatchObject({ text: "Keep it short.", status: "pending" });
    harness.event("user.message", { content: "Keep it short.", delivery: "steering" });
    expect(harness.session.live.snapshot().steering?.at(-1)).toMatchObject({ text: "Keep it short.", status: "delivered" });

    harness.session.controls.steer?.("One more thing.");
    harness.event("assistant.idle", {}, { ephemeral: true });
    expect(harness.session.live.snapshot().steering?.at(-1)).toMatchObject({ text: "One more thing.", status: "failed" });
  });

  it("shuts the server down when the session cannot be created", () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.session.start();
    harness.reply("connect", { ok: true });
    const update = harness.receive({ id: harness.last("session.create")?.id, error: { code: -32603, message: "Custom agent not found" } });
    expect(update.resultExitCode).toBe(1);
    expect(harness.session.getFailureMessage()).toBe("Custom agent not found");
    expect(harness.last("runtime.shutdown")).toBeDefined();
    harness.reply("runtime.shutdown");
    expect(harness.isClosed()).toBe(true);
    expect(harness.session.hasTerminalResult()).toBe(true);
  });

  it("answers ask_user itself for unattended runs", () => {
    const sent: string[] = [];
    const unattended = new CopilotServerSession(
      { prompt: "Go.", imagePaths: [], session: {}, skipCustomInstructions: false },
      { write: (text) => sent.push(text), closeInput: () => undefined },
      () => undefined,
      { model: "claude-haiku-5.5", captureEvidence: false, unattended: true },
    );
    disposeAll.push(() => unattended.dispose());
    expect(unattended.live.snapshot().capabilities).toEqual([]);
    unattended.push(encodeContentLengthFrame({ jsonrpc: "2.0", id: 5, method: "userInput.request", params: { question: "Name?" } }));
    expect(sent.join("")).toContain('"wasFreeform":true');
    expect(unattended.live.getQuestion()).toBeUndefined();
  });

  it("aborts the turn and reports the interruption", () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.open();
    expect(harness.session.interrupt()).toBe(true);
    expect(harness.last("session.abort")?.params).toEqual({ sessionId: SESSION_ID });

    const update = harness.event("session.idle", { aborted: true }, { ephemeral: true });
    expect(update.resultExitCode).toBe(1);
    expect(harness.session.getFailureMessage()).toBe("The turn was interrupted.");
    expect(harness.session.interrupt()).toBe(false);
    expect(() => harness.session.controls.steer?.("late")).toThrow("finished");
  });

  it("lists background shells with a stop handle and stops leftovers at the end", async () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.open();
    harness.event("session.background_tasks_changed", {}, { ephemeral: true });
    // The task list is fetched after a short debounce.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.last("session.tasks.list")?.params).toEqual({ sessionId: SESSION_ID });
    harness.reply("session.tasks.list", {
      tasks: [
        { type: "shell", id: "0", description: "Ping in the background", status: "running", startedAt: "2026-10-29T15:20:56.957Z" },
        { type: "shell", id: "1", description: "Build", status: "running" },
      ],
    });
    expect(harness.session.live.getTask("0")).toMatchObject({ kind: "shell", status: "running", background: true, canStop: true });

    harness.session.controls.stopTask?.("0");
    expect(harness.last("session.tasks.cancel")?.params).toEqual({ sessionId: SESSION_ID, id: "0" });
    harness.reply("session.tasks.cancel", { cancelled: true });
    expect(harness.session.live.getTask("0")).toMatchObject({ status: "stopped", canStop: false });
    expect(() => harness.session.controls.stopTask?.("0")).toThrow("not running");

    harness.event("assistant.idle", {}, { ephemeral: true });
    expect(harness.session.live.getTask("1")?.status).toBe("stopped");
    expect(harness.session.live.snapshot().notices?.at(-1)?.text).toBe("Stopped 1 background task when the turn ended.");
  });

  it("reports quota only for limited plans", () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.session.start();
    harness.reply("connect", { ok: true });
    harness.reply("account.getQuota", {
      quotaSnapshots: {
        chat: { isUnlimitedEntitlement: true, remainingPercentage: 100 },
        premium_interactions: { isUnlimitedEntitlement: false, remainingPercentage: 12.5, resetDate: "2026-11-01T00:00:00Z" },
      },
    });
    expect(harness.session.live.snapshot().limits).toEqual([
      { id: "copilot-premium_interactions", label: "Premium requests", usedPercent: 87.5, resetsAt: Date.parse("2026-11-01T00:00:00Z") },
    ]);
  });

  it("fails the run when Copilot exits before the turn ends", () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.open();
    const update = harness.session.finish();
    expect(update.resultExitCode).toBe(1);
    expect(harness.session.getFailureMessage()).toBe("Copilot exited before the turn finished.");
  });

  it("ignores events from other sessions", () => {
    const harness = createHarness();
    disposeAll.push(() => harness.session.dispose());
    harness.open();
    harness.receive({ method: "session.event", params: { sessionId: "other", event: { type: "assistant.idle", data: {} } } });
    expect(harness.session.hasTerminalResult()).toBe(false);
    expect(harness.last("session.destroy")).toBeUndefined();
  });
});
