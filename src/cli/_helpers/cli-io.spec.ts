import type {
  TaskExecutionProgress,
  TaskExecutionResult,
} from "../../core/types.ts";
import {
  createVerboseProgressReporter,
  formatExecutionSummaryLines,
  STRUCTURED_PROGRESS_PREFIX,
} from "./cli-io.ts";

const createExecution = (
  overrides: Partial<TaskExecutionResult> = {},
): TaskExecutionResult => {
  return {
    task: "What is the weather?",
    mode: "auto",
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
        title: "Autopilot audit",
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
});
