import type { TaskExecutionResult } from "../../core/types.ts";
import { formatExecutionSummaryLines } from "./cli-io.ts";

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
        lines: ["task: What is the weather?"],
      },
      {
        title: "Autopilot audit",
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
