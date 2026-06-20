import { createTaskDidNotExecuteFeedback } from "./create-task-did-not-execute-feedback.helper.ts";
import type { TaskExecutionResult } from "../types.ts";

const createResult = (
  overrides: Partial<Pick<TaskExecutionResult, "status" | "summary" | "reason">>,
): TaskExecutionResult => ({
  task: "Generate",
  mode: "auto",
  status: "blocked",
  summary: "Could not run.",
  executedTools: [],
  outputSections: [],
  ...overrides,
});

describe("createTaskDidNotExecuteFeedback", () => {
  it("reports the actor status and reason", () => {
    expect(
      createTaskDidNotExecuteFeedback(
        "generator",
        createResult({ reason: "The model was unavailable." }),
      ),
    ).toBe(
      "The Ralph generator did not execute successfully (blocked): The model was unavailable.",
    );
  });

  it("falls back to the result summary when reason is missing", () => {
    expect(createTaskDidNotExecuteFeedback("validator", createResult({}))).toBe(
      "The Ralph validator did not execute successfully (blocked): Could not run.",
    );
  });
});
