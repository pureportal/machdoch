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
  it("prints the user-facing result as the final block", () => {
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

    expect(lines.indexOf("autopilot audit:")).toBeLessThan(
      lines.indexOf("result:"),
    );
    expect(lines.slice(-2)).toEqual([
      "result:",
      "I need a location to answer that.",
    ]);
  });

  it("does not synthesize a result block without a structured response", () => {
    const lines = formatExecutionSummaryLines(
      createExecution({
        outputSections: [
          {
            title: "Agent answer",
            lines: ["1: I need a location to answer that."],
          },
        ],
      }),
    );

    expect(lines).toContain("agent answer:");
    expect(lines).not.toContain("result:");
  });
});
