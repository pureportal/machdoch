import type {
  TaskExecutionProgress,
  TaskExecutionResult,
} from "../../core/types.ts";
import {
  createActionFeedbackProgressReporter,
  createVerboseProgressReporter,
  formatExecutionSummaryLines,
  STRUCTURED_PROGRESS_PREFIX,
} from "./cli-io.ts";

const createExecution = (
  overrides: Partial<TaskExecutionResult> = {},
): TaskExecutionResult => {
  return {
    task: "What is the weather?",
    mode: "machdoch",
    status: "blocked",
    summary: "I need a location to answer that.",
    executedTools: ["filesystem"],
    outputSections: [
      {
        title: "Task context",
        audience: "internal",
        lines: ["task: What is the weather?"],
      },
      {
        title: "Machdoch review",
        audience: "internal",
        lines: ["executor iterations: 1/4"],
      },
    ],
    ...overrides,
  };
};

describe("formatExecutionSummaryLines", () => {
  it("prints only the user-facing result when a structured response exists", () => {
    const lines = formatExecutionSummaryLines(
      createExecution({
        response: {
          markdown: "I need a location to answer that.",
          highlights: [],
          relatedFiles: [],
          verification: [],
          followUps: [],
        },
      }),
    );

    expect(lines).toEqual(["I need a location to answer that."]);
  });

  it("keeps fallback output concise without internal sections", () => {
    const lines = formatExecutionSummaryLines(
      createExecution({
        outputSections: [
          {
            title: "Agent answer",
            lines: ["1: I need a location to answer that."],
          },
          {
            title: "Tool trace",
            audience: "internal",
            lines: ["tool_call: read_file(...)"],
          },
        ],
      }),
    );

    expect(lines).toEqual([
      "Blocked: I need a location to answer that.",
      "",
      "Agent answer:",
      "1: I need a location to answer that.",
    ]);
  });
});

describe("createVerboseProgressReporter", () => {
  it("can emit structured progress without localized text parsing", () => {
    const lines: string[] = [];
    const progress: TaskExecutionProgress = {
      task: "show README.md",
      mode: "ask",
      state: "executing",
      message: "Reading workspace files",
      executedTools: [],
      outputSections: [],
      cancellable: true,
    };
    const reporter = createVerboseProgressReporter((line) => {
      lines.push(line);
    }, { structured: true });

    reporter(progress);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(STRUCTURED_PROGRESS_PREFIX)).toBe(true);
    expect(
      JSON.parse(lines[0]?.slice(STRUCTURED_PROGRESS_PREFIX.length) ?? "{}"),
    ).toEqual(progress);
  });

  it("emits terminal states for structured desktop progress", () => {
    const lines: string[] = [];
    const progress: TaskExecutionProgress = {
      task: "show README.md",
      mode: "ask",
      state: "completed",
      message: "Workspace scan complete.",
      executedTools: ["filesystem"],
      outputSections: [],
      cancellable: false,
    };
    const reporter = createVerboseProgressReporter((line) => {
      lines.push(line);
    }, { structured: true });

    reporter(progress);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith(STRUCTURED_PROGRESS_PREFIX)).toBe(true);
    expect(
      JSON.parse(lines[0]?.slice(STRUCTURED_PROGRESS_PREFIX.length) ?? "{}"),
    ).toEqual(progress);
  });

  it("keeps terminal states out of human verbose progress", () => {
    const lines: string[] = [];
    const reporter = createVerboseProgressReporter((line) => {
      lines.push(line);
    });

    reporter({
      task: "show README.md",
      mode: "ask",
      state: "completed",
      message: "Workspace scan complete.",
      executedTools: ["filesystem"],
      outputSections: [],
      cancellable: false,
    });

    expect(lines).toEqual([]);
  });
});

describe("createActionFeedbackProgressReporter", () => {
  it("prints a compact actions block for interactive chat progress", () => {
    const lines: string[] = [];
    const createProgress = (
      state: TaskExecutionProgress["state"],
      message: string,
    ): TaskExecutionProgress => ({
      task: "Check the docker state",
      mode: "machdoch",
      state,
      message,
      executedTools: [],
      outputSections: [],
      cancellable: true,
    });
    const reporter = createActionFeedbackProgressReporter((line = "") => {
      lines.push(line);
    });

    reporter.report(
      createProgress("resolving-context", "Resolve workspace context."),
    );
    reporter.report(createProgress("executing", "Executor iteration 1 started."));
    reporter.report(
      createProgress("executing", "Requested run shell command: docker ps."),
    );
    reporter.reportOutput({
      toolName: "run_shell_command",
      stream: "stdout",
      chunk: "CONTAINER ID   IMAGE\n",
    });
    reporter.reportOutput({
      toolName: "run_shell_command",
      stream: "stdout",
      chunk: "abc123         postgres",
    });
    reporter.report(
      createProgress(
        "executing",
        "run shell command finished: exit code 0, stdout 6 containers",
      ),
    );
    reporter.report(
      createProgress(
        "executing",
        "run shell command finished: exit code 0, stdout 6 containers",
      ),
    );
    reporter.finish();

    expect(lines).toEqual([
      "--- Actions Start ---",
      "thinking: Executor iteration 1 started.",
      'action: execute command "docker ps"',
      "stdout: CONTAINER ID   IMAGE",
      "thinking: run shell command finished: exit code 0, stdout 6 containers",
      "stdout: abc123         postgres",
      "--- Actions End ---",
      "",
    ]);
  });
});
