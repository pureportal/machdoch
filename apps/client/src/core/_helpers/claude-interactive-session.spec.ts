import { afterEach, describe, expect, it } from "vitest";
import type { AgentModelImageInput } from "@machdoch/model-runtime/types";
import { ClaudeInteractiveSession } from "./claude-interactive-session.js";

type Message = Record<string, unknown> & {
  request_id?: string;
  request?: Record<string, unknown>;
};

const createHarness = (
  fastMode = false,
  unattended = false,
  imageInputs: AgentModelImageInput[] = [],
  turnLimitContinuations?: number | null,
) => {
  const sent: Message[] = [];
  let closed = false;
  const session = new ClaudeInteractiveSession(
    {
      prompt: "Do the task.",
      imageInputs,
      ...(turnLimitContinuations !== undefined
        ? { turnLimitContinuations }
        : {}),
    },
    {
      write: (text) => {
        for (const line of text.split("\n").filter(Boolean))
          sent.push(JSON.parse(line) as Message);
      },
      closeInput: () => {
        closed = true;
      },
    },
    () => undefined,
    { model: "opus", captureEvidence: false, fastMode, unattended },
  );
  const receive = (event: Record<string, unknown>) =>
    session.push(`${JSON.stringify(event)}\n`);
  const controlRequest = (subtype: string) =>
    [...sent]
      .reverse()
      .find(
        (message) =>
          message.type === "control_request" &&
          message.request?.subtype === subtype,
      );
  const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
    receive({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
  const toolResult = (id: string, result: Record<string, unknown>) =>
    receive({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      },
      tool_use_result: result,
    });
  return {
    session,
    sent,
    receive,
    controlRequest,
    toolUse,
    toolResult,
    isClosed: () => closed,
  };
};

const maxTurnsResult = {
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  num_turns: 8,
  errors: [],
  usage: { input_tokens: 10, output_tokens: 2 },
};

let sessions: ClaudeInteractiveSession[] = [];
afterEach(() => {
  for (const session of sessions) session.dispose();
  sessions = [];
});

describe("ClaudeInteractiveSession", () => {
  it("opens the turn with initialize and the prompt", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.session.start();
    expect(harness.controlRequest("initialize")?.request).toMatchObject({
      promptSuggestions: true,
      agentProgressSummaries: true,
    });
    expect(harness.sent.at(-1)).toMatchObject({
      type: "user",
      message: { role: "user", content: "Do the task." },
    });
  });

  it("sends attached images as image blocks before the prompt", () => {
    const harness = createHarness(false, false, [
      { path: "C:/shots/screen.png", mediaType: "image/png", data: "aW1hZ2U=" },
    ]);
    sessions.push(harness.session);
    harness.session.start();
    expect(harness.sent.at(-1)).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aW1hZ2U=",
            },
          },
          { type: "text", text: "Do the task." },
        ],
      },
    });
  });

  it("builds the live plan from Claude's task list tools", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.session.start();
    harness.toolUse("t1", "TaskCreate", {
      subject: "Read the file",
      description: "x",
    });
    harness.toolResult("t1", { task: { id: "1", subject: "Read the file" } });
    harness.toolUse("t2", "TaskCreate", { subject: "Reply", description: "y" });
    harness.toolResult("t2", { task: { id: "2", subject: "Reply" } });
    harness.toolUse("t3", "TaskUpdate", { taskId: "1", status: "completed" });
    harness.toolUse("t4", "TaskUpdate", { taskId: "2", status: "in_progress" });
    expect(harness.session.live.snapshot().plan).toEqual([
      { text: "Read the file", status: "completed" },
      { text: "Reply", status: "in_progress" },
    ]);
    harness.toolUse("t5", "TaskUpdate", { taskId: "1", status: "deleted" });
    expect(harness.session.live.snapshot().plan).toEqual([
      { text: "Reply", status: "in_progress" },
    ]);
  });

  it("still reads TodoWrite plans", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.toolUse("t1", "TodoWrite", {
      todos: [
        { content: "One", status: "completed" },
        { content: "Two", status: "pending" },
      ],
    });
    expect(harness.session.live.snapshot().plan).toEqual([
      { text: "One", status: "completed" },
      { text: "Two", status: "pending" },
    ]);
  });

  it("reports the fast tier the CLI granted and why it was refused", () => {
    const granted = createHarness(true);
    sessions.push(granted.session);
    granted.session.start();
    granted.receive({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: granted.controlRequest("initialize")?.request_id,
        response: { fast_mode_state: "on" },
      },
    });
    expect(granted.session.live.snapshot().fastMode).toBe(true);

    const refused = createHarness(true);
    sessions.push(refused.session);
    refused.session.start();
    refused.receive({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: refused.controlRequest("initialize")?.request_id,
        response: {
          fast_mode_state: "off",
          fast_mode_disabled_reason: "extra_usage_disabled",
        },
      },
    });
    const live = refused.session.live.snapshot();
    expect(live.fastMode).toBe(false);
    expect(live.notices?.at(-1)?.text).toMatch(/^Fast mode is not available:/);
  });

  it("marks a steer read when Claude echoes it and fails the ones it never read", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.session.start();
    harness.session.controls.steer?.("Also add tests.");
    harness.session.controls.steer?.("And update the docs.");
    expect(harness.sent.at(-1)).toMatchObject({
      type: "user",
      priority: "next",
      message: { content: "And update the docs." },
    });
    expect(
      harness.session.live.snapshot().steering?.map((steer) => steer.status),
    ).toEqual(["pending", "pending"]);

    harness.receive({
      type: "user",
      isReplay: true,
      message: { role: "user", content: "Also add tests." },
    });
    harness.receive({
      type: "result",
      subtype: "success",
      result: "Done.",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    expect(harness.session.live.snapshot().steering).toEqual([
      { id: "steer-1", text: "Also add tests.", status: "delivered" },
      {
        id: "steer-2",
        text: "And update the docs.",
        status: "failed",
        error: "The turn ended before Claude read this message.",
      },
    ]);
    expect(harness.isClosed()).toBe(true);
    expect(() => harness.session.controls.steer?.("late")).toThrow("finished");
  });

  it("declines questions for unattended runs instead of waiting", () => {
    const harness = createHarness(false, true);
    sessions.push(harness.session);
    expect(harness.session.live.snapshot().capabilities).toEqual([]);
    harness.receive({
      type: "control_request",
      request_id: "req-2",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Which DB?" }] },
      },
    });
    expect(harness.sent.at(-1)).toMatchObject({
      response: {
        request_id: "req-2",
        response: {
          behavior: "deny",
          message: expect.stringContaining("Nobody can answer"),
        },
      },
    });
    expect(harness.session.live.getQuestion()).toBeUndefined();
  });

  it("turns AskUserQuestion into a question card and answers with the question text keys", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.session.start();
    const input = {
      questions: [
        {
          question: "Which DB?",
          header: "Database",
          options: [{ label: "Postgres" }, { label: "SQLite" }],
        },
      ],
    };
    harness.receive({
      type: "control_request",
      request_id: "req-9",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input },
    });
    const question = harness.session.live.getQuestion();
    expect(question).toMatchObject({
      status: "pending",
      items: [{ id: "q1", header: "Database", question: "Which DB?" }],
    });

    harness.session.controls.answer?.(question!.id, { q1: "SQLite" });
    expect(harness.sent.at(-1)).toMatchObject({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-9",
        response: {
          behavior: "allow",
          updatedInput: { ...input, answers: { "Which DB?": "SQLite" } },
        },
      },
    });
  });

  it("lets ordinary tool permission requests through", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.receive({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
      },
    });
    expect(harness.sent.at(-1)).toMatchObject({
      response: {
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: { command: "ls" } },
      },
    });
  });

  it("resumes in place at the turn limit until the continuations run out", () => {
    const harness = createHarness(false, false, [], 1);
    sessions.push(harness.session);
    harness.session.start();

    expect(harness.receive(maxTurnsResult).resultExitCode).toBeUndefined();
    expect(harness.isClosed()).toBe(false);
    expect(harness.sent.at(-1)).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: expect.stringContaining("Continue the task"),
      },
    });
    expect(harness.session.live.snapshot().notices?.at(-1)?.text).toContain(
      "(1 of 1)",
    );

    expect(harness.receive(maxTurnsResult).resultExitCode).toBe(1);
    expect(harness.isClosed()).toBe(true);
    expect(harness.session.reachedTurnLimit()).toBe(true);
    // Claude counts turns and usage per prompt, so both parts add up.
    expect(harness.session.getModelCallCount()).toBe(16);
    expect(harness.session.getUsage()).toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
    });
    expect(harness.session.live.snapshot().usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
    });
  });

  it("ends the turn at the turn limit without continuations or after an interrupt", () => {
    const capped = createHarness();
    sessions.push(capped.session);
    capped.session.start();
    expect(capped.receive(maxTurnsResult).resultExitCode).toBe(1);
    expect(capped.isClosed()).toBe(true);
    expect(capped.session.reachedTurnLimit()).toBe(true);

    const unlimited = createHarness(false, false, [], null);
    sessions.push(unlimited.session);
    unlimited.session.start();
    unlimited.receive(maxTurnsResult);
    unlimited.receive(maxTurnsResult);
    expect(unlimited.isClosed()).toBe(false);
    expect(unlimited.session.live.snapshot().notices?.at(-1)?.text).toContain(
      "(2)",
    );
    unlimited.session.interrupt();
    unlimited.receive(maxTurnsResult);
    expect(unlimited.isClosed()).toBe(true);
  });

  describe("while background jobs run after the turn", () => {
    const jobs = (count: number) => ({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: Array.from({ length: count }, (_, index) => ({
        task_id: `job-${index}`,
      })),
    });
    const success = (text: string, inputTokens: number) => ({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: text,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    });
    const assistant = (id: string, text: string) => ({
      type: "assistant",
      message: { id, content: [{ type: "text", text }] },
    });

    it("keeps the session open and takes the wake-up turn's result as final", () => {
      const harness = createHarness();
      sessions.push(harness.session);
      harness.session.start();
      harness.receive(jobs(1));
      const waiting = harness.receive(success("Tests are still running.", 10));
      expect(harness.isClosed()).toBe(false);
      expect(waiting.displayText.at(-1)).toContain(
        "Waiting for 1 background job",
      );
      expect(harness.session.getCompletionGraceMs()).toBe(10 * 60 * 1_000);

      harness.receive(jobs(0));
      harness.receive(assistant("message-2", "All tests passed."));
      expect(harness.session.hasTerminalResult()).toBe(false);
      expect(harness.isClosed()).toBe(false);

      const final = harness.receive(success("All tests passed.", 20));
      expect(final.resultExitCode).toBe(0);
      expect(harness.isClosed()).toBe(true);
      expect(harness.session.hasTerminalResult()).toBe(true);
      expect(harness.session.getCompletionGraceMs()).toBeUndefined();
      expect(harness.session.getFinalOutput()).toBe("All tests passed.");
      expect(harness.session.getUsage()).toMatchObject({ inputTokens: 30 });
    });

    it("still ends at once when no job is running", () => {
      const harness = createHarness();
      sessions.push(harness.session);
      harness.session.start();
      harness.receive(jobs(1));
      harness.receive(jobs(0));
      harness.receive(success("Done.", 10));
      expect(harness.isClosed()).toBe(true);
    });

    it("ends a failed turn at once", () => {
      const harness = createHarness();
      sessions.push(harness.session);
      harness.session.start();
      harness.receive(jobs(1));
      harness.receive({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["The API failed."],
      });
      expect(harness.isClosed()).toBe(true);
      expect(harness.session.getCompletionGraceMs()).toBeUndefined();
    });

    it("lets the user stop or steer the waiting run", () => {
      const stopped = createHarness();
      sessions.push(stopped.session);
      stopped.session.start();
      stopped.receive(jobs(1));
      stopped.receive(success("Waiting.", 10));
      expect(stopped.session.interrupt()).toBe(true);
      expect(stopped.isClosed()).toBe(true);
      expect(stopped.session.interrupt()).toBe(false);

      const steered = createHarness();
      sessions.push(steered.session);
      steered.session.start();
      steered.receive(jobs(1));
      steered.receive(success("Waiting.", 10));
      steered.session.controls.steer?.("Skip the build.");
      expect(steered.sent.at(-1)).toMatchObject({
        type: "user",
        priority: "next",
        message: { content: "Skip the build." },
      });
      expect(steered.isClosed()).toBe(false);
    });

    it("reports an expired wait as unfinished", () => {
      const harness = createHarness();
      sessions.push(harness.session);
      harness.session.start();
      harness.receive(jobs(1));
      harness.receive(success("Still running.", 10));
      for (let step = 0; step < 5; step += 1) {
        expect(harness.session.takeBackgroundWaitNotice()).toBeDefined();
      }
      expect(harness.session.takeBackgroundWaitNotice()).toBeUndefined();
      expect(harness.session.backgroundWaitExpired()).toBe(true);
    });
  });

  it("interrupts and drops queued steering", () => {
    const harness = createHarness();
    sessions.push(harness.session);
    harness.session.start();
    expect(harness.session.interrupt()).toBe(true);
    expect(harness.controlRequest("interrupt")?.request).toEqual({
      subtype: "interrupt",
      cancel_queued: true,
    });
  });
});
