import { createGenerationActorResultMessage } from "./create-generation-actor-result-message.helper.ts";
import type { TaskExecutionResult } from "../types.ts";

const createResult = (
  overrides: Partial<Pick<TaskExecutionResult, "status" | "summary" | "reason">>,
): TaskExecutionResult => ({
  task: "Generate",
  mode: "auto",
  status: "executed",
  summary: "Done.",
  executedTools: [],
  outputSections: [],
  ...overrides,
});

describe("createGenerationActorResultMessage", () => {
  it("returns a concise completion message for executed actors", () => {
    expect(createGenerationActorResultMessage("generator", createResult({}))).toBe(
      "Ralph generator completed.",
    );
  });

  it("uses reason before summary for non-executed actors", () => {
    expect(
      createGenerationActorResultMessage(
        "validator",
        createResult({
          status: "blocked",
          summary: "Summary fallback.",
          reason: "Missing generated JSON.",
        }),
      ),
    ).toBe("Ralph validator returned blocked: Missing generated JSON.");
  });

  it("adds a period when non-executed feedback is empty", () => {
    expect(
      createGenerationActorResultMessage(
        "generator",
        createResult({ status: "cancelled", summary: "   " }),
      ),
    ).toBe("Ralph generator returned cancelled.");
  });
});
