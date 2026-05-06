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
});
