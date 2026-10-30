import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerSession,
  type CodexAppServerTurnInput,
} from "./codex-app-server-session.js";
import {
  describeShellCommand,
  summarizeUnifiedDiff,
} from "./codex-live-events.js";

type Message = Record<string, unknown> & { id?: number; method?: string; params?: Record<string, unknown> };

const WORKSPACE = join(process.cwd(), "fixture-workspace");

const createHarness = (input: Partial<CodexAppServerTurnInput> = {}) => {
  const sent: Message[] = [];
  let closed = false;
  const session = new CodexAppServerSession(
    { prompt: "Fix it.", imagePaths: [], thread: { model: "gpt-6-luna", cwd: WORKSPACE }, turn: {}, ...input },
    {
      write: (text) => {
        for (const line of text.split("\n").filter(Boolean)) sent.push(JSON.parse(line) as Message);
      },
      closeInput: () => {
        closed = true;
      },
    },
    () => undefined,
    { model: "gpt-6-luna", captureEvidence: false },
  );
  const last = (method: string) => [...sent].reverse().find((message) => message.method === method);
  const receive = (message: Record<string, unknown>) => session.push(`${JSON.stringify(message)}\n`);
  const reply = (method: string, result: Record<string, unknown>) => receive({ id: last(method)?.id, result });
  const startThread = () => {
    session.start();
    reply("initialize", {});
    reply("thread/start", { thread: { id: "thread-1" } });
  };
  return { session, sent, last, receive, reply, startThread, isClosed: () => closed };
};

let sessions: CodexAppServerSession[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
});

describe("describeShellCommand", () => {
  it.each([
    [String.raw`"C:\Users\me\AppData\Local\Microsoft\WindowsApps\pwsh.exe" -Command 'Get-Content -LiteralPath calc.py'`, "Get-Content -LiteralPath calc.py"],
    [String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command 'python -c "print(1)"'`, `python -c "print(1)"`],
    [`/bin/bash -lc "ls -la"`, "ls -la"],
    [`git status --short`, "git status --short"],
  ])("shows %s as %s", (command, expected) => {
    expect(describeShellCommand(command)).toBe(expected);
  });
});

describe("summarizeUnifiedDiff", () => {
  it("counts additions and deletions per file and spots new and deleted files", () => {
    const diff = [
      "diff --git a/calc.py b/calc.py",
      "--- a/calc.py",
      "+++ b/calc.py",
      "@@ -1,2 +1,2 @@",
      "-    return a - b",
      "+    return a + b",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "+++ b/new.txt",
      "+hello",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "-bye",
      'diff --git "a/my notes.md" "b/my notes.md"',
      "+line",
    ].join("\n");
    expect(summarizeUnifiedDiff(diff)).toEqual([
      { path: "calc.py", kind: "update", additions: 1, deletions: 1 },
      { path: "new.txt", kind: "add", additions: 1, deletions: 0 },
      { path: "old.txt", kind: "delete", additions: 0, deletions: 1 },
      { path: "my notes.md", kind: "update", additions: 1, deletions: 0 },
    ]);
  });
});

describe("CodexAppServerSession", () => {
  it("answers questions itself and does not invite them when unattended", () => {
    const sent: Message[] = [];
    const session = new CodexAppServerSession(
      { prompt: "Fix it.", imagePaths: [], thread: {}, turn: {} },
      {
        write: (text) => {
          for (const line of text.split("\n").filter(Boolean)) sent.push(JSON.parse(line) as Message);
        },
        closeInput: () => undefined,
      },
      () => undefined,
      { model: "gpt-6-luna", captureEvidence: false, unattended: true },
    );
    sessions.push(session);
    session.start();
    session.push(`${JSON.stringify({ id: sent.at(-1)?.id, result: {} })}\n`);
    const threadStart = sent.find((message) => message.method === "thread/start");
    expect(threadStart?.params).toMatchObject({ config: { "features.default_mode_request_user_input": false } });
    expect(session.live.snapshot().capabilities).toEqual([]);

    session.push(`${JSON.stringify({ id: 9, method: "item/tool/requestUserInput", params: { questions: [{ id: "lang", question: "Which?" }] } })}\n`);
    expect(sent.find((message) => message.id === 9)).toMatchObject({
      result: { answers: { lang: { answers: [expect.stringContaining("Nobody can answer")] } } },
    });
  });

  it("joins messages sent before the turn starts to the opening prompt", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.session.start();
    harness.reply("initialize", {});
    harness.session.controls.steer?.("Also add a test.");
    harness.reply("thread/start", { thread: { id: "thread-1" } });

    const turn = harness.last("turn/start")?.params as { input: { text: string }[] };
    expect(turn.input[0]?.text).toBe("Fix it.\n\nAlso add a test.");
    expect(harness.session.live.snapshot().steering).toEqual([{ id: "steer-1", text: "Also add a test.", status: "delivered" }]);
  });

  it("steers the running turn and records failures", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.startThread();
    harness.reply("turn/start", { turn: { id: "turn-1" } });

    harness.session.controls.steer?.("Use tabs.");
    expect(harness.last("turn/steer")?.params).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });
    harness.receive({ id: harness.last("turn/steer")?.id, error: { code: -32600, message: "turn already finished" } });
    expect(harness.session.live.snapshot().steering?.at(-1)).toMatchObject({ status: "failed", error: "turn already finished" });
  });

  it("runs a native review that cannot be steered", () => {
    const harness = createHarness({ review: { target: { type: "uncommittedChanges" } } });
    sessions.push(harness.session);
    harness.startThread();
    expect(harness.last("review/start")?.params).toEqual({ threadId: "thread-1", target: { type: "uncommittedChanges" } });
    expect(harness.session.live.snapshot().capabilities).toEqual(["interrupt"]);
    expect(() => harness.session.controls.steer?.("more")).toThrow("cannot be steered");

    harness.reply("review/start", { turn: { id: "review-turn" } });
    harness.receive({
      method: "item/completed",
      params: { threadId: "thread-1", item: { id: "r1", type: "exitedReviewMode", review: "No issues found." } },
    });
    harness.receive({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "other-id", status: "completed" } } });
    expect(harness.session.getFinalOutput()).toBe("No issues found.");
    expect(harness.isClosed()).toBe(true);
  });

  it("reports file changes relative to the workspace, matching the diff", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.startThread();
    harness.reply("turn/start", { turn: { id: "turn-1" } });
    harness.receive({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: { id: "f1", type: "fileChange", status: "completed", changes: [{ path: join(WORKSPACE, "src", "calc.py"), kind: { type: "update" } }] },
      },
    });
    harness.receive({
      method: "turn/diff/updated",
      params: { threadId: "thread-1", diff: "diff --git a/src/calc.py b/src/calc.py\n+++ b/src/calc.py\n+x\n-y" },
    });
    expect(harness.session.live.snapshot().fileChanges).toEqual([
      { path: "src/calc.py", kind: "update", additions: 1, deletions: 1 },
    ]);
  });

  it("maps plan, usage and plan-limit notifications", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.startThread();
    harness.reply("turn/start", { turn: { id: "turn-1" } });
    harness.receive({
      method: "turn/plan/updated",
      params: { threadId: "thread-1", plan: [{ step: "Read", status: "completed" }, { step: "Fix", status: "inProgress" }] },
    });
    harness.receive({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: { total: { inputTokens: 1_000, outputTokens: 50, cachedInputTokens: 600 }, last: { inputTokens: 900 }, modelContextWindow: 272_000 },
      },
    });
    harness.receive({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          rateLimitReachedType: "secondary",
          primary: { usedPercent: 20, windowDurationMins: 300 },
          secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 1_793_800_000 },
        },
      },
    });
    const live = harness.session.live.snapshot();
    expect(live.plan).toEqual([{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }]);
    expect(live.usage).toMatchObject({ inputTokens: 1_000, contextUsedTokens: 900, contextWindowTokens: 272_000 });
    expect(live.limits).toEqual([
      { id: "codex-primary", label: "5-hour limit", usedPercent: 20 },
      { id: "codex-secondary", label: "Weekly limit", usedPercent: 50, resetsAt: 1_793_800_000_000, limited: true },
    ]);
  });

  it("asks clarifying questions and fails the turn when it is interrupted", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.startThread();
    harness.reply("turn/start", { turn: { id: "turn-1" } });
    harness.receive({
      id: 41,
      method: "item/tool/requestUserInput",
      params: { questions: [{ id: "lang", question: "Which language?", options: [{ label: "Go" }, { label: "Rust" }] }] },
    });
    expect(harness.session.live.getQuestion()).toMatchObject({ status: "pending", items: [{ id: "lang", options: [{ label: "Go" }, { label: "Rust" }] }] });

    expect(harness.session.interrupt()).toBe(true);
    expect(harness.sent.find((message) => message.id === 41)).toMatchObject({ error: { code: -32800 } });
    expect(harness.session.live.getQuestion()?.status).toBe("cancelled");
    const update = harness.receive({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } });
    expect(update.resultExitCode).not.toBe(0);
  });
});
