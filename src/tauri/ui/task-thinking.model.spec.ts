import type { TaskExecutionProgress } from "../../core/types.ts";
import {
  appendThinkingProgress,
  createInitialThinkingTrace,
} from "./task-thinking.model";

const createProgress = (
  overrides: Partial<TaskExecutionProgress> = {},
): TaskExecutionProgress => {
  return {
    task: "scan workspace",
    mode: "ask",
    state: "executing",
    message: "Requested read file on README.md.",
    executedTools: [],
    outputSections: [],
    cancellable: true,
    ...overrides,
  };
};

describe("task thinking model", () => {
  it("tracks the latest activity timestamp for repeated progress", () => {
    const progress = createProgress({ message: "Streaming model response." });
    const initialTrace = createInitialThinkingTrace("ask", 1);
    const withFirstUpdate = appendThinkingProgress(initialTrace, progress, 2);
    const withRepeatedUpdate = appendThinkingProgress(
      withFirstUpdate,
      progress,
      3,
    );

    expect(initialTrace.lastActivityAt).toBe(1);
    expect(withFirstUpdate.lastActivityAt).toBe(2);
    expect(withRepeatedUpdate.lastActivityAt).toBe(3);
  });

  it("tracks the exact timeout state reported by the execution runtime", () => {
    const trace = appendThinkingProgress(
      createInitialThinkingTrace("ask", 50),
      createProgress({
        timeout: {
          startedAt: 100,
          lastActivityAt: 125,
          idleTimeoutMs: 1_000,
          absoluteTimeoutMs: 5_000,
        },
      }),
      150,
    );

    expect(trace.timeout).toEqual({
      startedAt: 100,
      lastActivityAt: 125,
      idleTimeoutMs: 1_000,
      absoluteTimeoutMs: 5_000,
    });
    expect(trace.lastActivityAt).toBe(125);
  });

  it("advances an active timeout for progress without an embedded snapshot", () => {
    const trace = appendThinkingProgress(
      {
        ...createInitialThinkingTrace("ask", 100),
        timeout: {
          startedAt: 100,
          lastActivityAt: 100,
          idleTimeoutMs: 1_000,
          absoluteTimeoutMs: 5_000,
        },
      },
      createProgress({ actionOutput: {
        toolName: "run_shell_command",
        stream: "stdout",
        chunk: "still running",
      } }),
      300,
    );

    expect(trace.timeout?.lastActivityAt).toBe(300);
  });

  it("appends structured progress without repeating the same tools line", () => {
    const initialTrace = createInitialThinkingTrace("ask", 1);
    const withRequest = appendThinkingProgress(
      initialTrace,
      createProgress(),
      2,
    );
    const withResult = appendThinkingProgress(
      withRequest,
      createProgress({
        message: "read file finished on README.md: read_file(README.md, 1-20)",
        executedTools: ["filesystem"],
      }),
      3,
    );
    const withNextRequest = appendThinkingProgress(
      withResult,
      createProgress({
        message: "Requested search workspace for \"TODO\".",
        executedTools: ["filesystem"],
      }),
      4,
    );

    expect(withNextRequest.status).toBe("running");
    expect(
      withNextRequest.entries.filter((entry) => entry.label === "Tools"),
    ).toHaveLength(1);
    expect(withNextRequest.entries.at(-1)).toMatchObject({
      label: "Executing",
      detail: "Requested search workspace for \"TODO\".",
    });
  });

  it("marks non-cancellable terminal progress complete", () => {
    const trace = appendThinkingProgress(
      createInitialThinkingTrace("ask", 1),
      createProgress({
        state: "cancelled",
        message: "Cancellation requested.",
        cancellable: false,
      }),
      2,
    );

    expect(trace.status).toBe("complete");
    expect(trace.entries.at(-1)).toMatchObject({
      label: "Cancelled",
      detail: "Cancellation requested.",
    });
  });

  it("bounds a long-running task trace to the latest eighty entries", () => {
    let trace = createInitialThinkingTrace("machdoch", 0);

    for (let index = 1; index <= 120; index += 1) {
      trace = appendThinkingProgress(
        trace,
        createProgress({ message: `Progress ${index}` }),
        index,
      );
    }

    expect(trace.entries).toHaveLength(80);
    expect(trace.entries[0]?.detail).toBe("Progress 41");
    expect(trace.entries.at(-1)?.detail).toBe("Progress 120");
  });

  it("keeps generated ids unique after bounded buffers roll over", () => {
    let trace = createInitialThinkingTrace("machdoch", 10);

    for (let index = 1; index <= 130; index += 1) {
      trace = appendThinkingProgress(
        trace,
        createProgress({ message: `Progress ${index}` }),
        20,
      );
    }

    const entryIds = trace.entries.map((entry) => entry.id);
    const timelineIds = trace.timelineEvents?.map((event) => event.id) ?? [];

    expect(new Set(entryIds).size).toBe(entryIds.length);
    expect(new Set(timelineIds).size).toBe(timelineIds.length);
  });

  it("records typed timeline telemetry with elapsed time and token usage", () => {
    const trace = appendThinkingProgress(
      createInitialThinkingTrace("ask", 10),
      createProgress({
        message: "Model token usage reported.",
        timelineEvent: {
          kind: "model-call",
          phase: "usage",
          label: "Token usage",
          detail: "10 input, 5 output, 15 total",
          provider: "openai",
          model: "gpt-5.5",
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
          metadata: {
            executorIteration: 1,
            modelCall: 1,
          },
        },
      }),
      25,
    );

    expect(trace.startedAt).toBe(10);
    expect(trace.task).toBe("scan workspace");
    expect(trace.entries).toHaveLength(1);
    expect(trace.timelineEvents).toHaveLength(1);
    expect(trace.timelineEvents?.[0]).toMatchObject({
      kind: "model-call",
      phase: "usage",
      label: "Token usage",
      elapsedMs: 15,
      provider: "openai",
      model: "gpt-5.5",
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });
    expect(trace.tokenUsage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const withLaterSnapshot = appendThinkingProgress(
      trace,
      createProgress({
        message: "Model token usage reported.",
        timelineEvent: {
          kind: "model-call",
          phase: "usage",
          label: "Token usage",
          detail: "12 input, 6 output, 18 total",
          provider: "openai",
          model: "gpt-5.5",
          tokenUsage: {
            inputTokens: 12,
            outputTokens: 6,
            totalTokens: 18,
          },
          metadata: {
            executorIteration: 1,
            modelCall: 1,
          },
        },
      }),
      30,
    );

    expect(withLaterSnapshot.tokenUsage).toEqual({
      inputTokens: 12,
      outputTokens: 6,
      totalTokens: 18,
    });

    const withNextIteration = appendThinkingProgress(
      withLaterSnapshot,
      createProgress({
        message: "Model token usage reported.",
        timelineEvent: {
          kind: "model-call",
          phase: "usage",
          label: "Token usage",
          detail: "3 input, 2 output, 5 total",
          provider: "openai",
          model: "gpt-5.5",
          tokenUsage: {
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
          },
          metadata: {
            executorIteration: 2,
            modelCall: 1,
          },
        },
      }),
      35,
    );

    expect(withNextIteration.tokenUsage).toEqual({
      inputTokens: 15,
      outputTokens: 8,
      totalTokens: 23,
    });
  });

  it("adds stdout and stderr chunks to the execution timeline", () => {
    const trace = appendThinkingProgress(
      createInitialThinkingTrace("machdoch", 100),
      createProgress({
        mode: "machdoch",
        message: "run_shell_command stdout output",
        actionOutput: {
          toolName: "run_shell_command",
          stream: "stdout",
          chunk: "line one\nline two\n",
        },
      }),
      160,
    );

    expect(trace.actionOutputLines).toHaveLength(2);
    expect(trace.timelineEvents).toHaveLength(2);
    expect(trace.timelineEvents?.map((event) => event.detail)).toEqual([
      "line one",
      "line two",
    ]);
    expect(trace.timelineEvents?.[0]).toMatchObject({
      kind: "output",
      phase: "streaming",
      elapsedMs: 60,
      stream: "stdout",
      toolName: "run_shell_command",
    });
  });
});
