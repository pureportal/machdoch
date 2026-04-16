import type { TaskExecutionResult } from "../../../../core/types.ts";
import {
  createExecutionThinkingTrace,
  createFallbackExecutionMarkdown,
  getExecutionMessageContent,
  getRelatedFileButtonLabel,
} from "./execution-message.tsx";

const createExecution = (
  overrides: Partial<TaskExecutionResult> = {},
): TaskExecutionResult => {
  return {
    task: overrides.task ?? "scan workspace",
    mode: overrides.mode ?? "ask",
    status: overrides.status ?? "executed",
    summary: overrides.summary ?? "Workspace scan complete.",
    executedTools: overrides.executedTools ?? ["filesystem"],
    outputSections: overrides.outputSections ?? [
      {
        title: "Verification",
        lines: ["Ran focused checks."],
      },
    ],
    ...(overrides.reason ? { reason: overrides.reason } : {}),
    ...(overrides.response ? { response: overrides.response } : {}),
    ...(overrides.autopilot ? { autopilot: overrides.autopilot } : {}),
    ...(overrides.memoryUpdates ? { memoryUpdates: overrides.memoryUpdates } : {}),
  };
};

describe("execution-message helpers", () => {
  it("creates a fallback execution markdown string from status and summary", () => {
    expect(
      createFallbackExecutionMarkdown(
        createExecution({ status: "approval-required", summary: "Needs approval." }),
      ),
    ).toBe("**Approval required.** Needs approval.");
  });

  it("prefers structured markdown over fallback content", () => {
    expect(
      getExecutionMessageContent(
        createExecution({
          response: {
            markdown: "**Updated the shell.**",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBe("**Updated the shell.**");
  });

  it("truncates long related file labels from the front", () => {
    expect(
      getRelatedFileButtonLabel(
        "src/tauri/ui/components/really/long/path/to/chat-session-shell.tsx",
      ),
    ).toMatch(/^…/u);
  });

  it("builds a thinking trace that includes the summary and output sections", () => {
    const trace = createExecutionThinkingTrace(
      createExecution({
        summary: "Workspace scan complete.",
        outputSections: [
          { title: "Task context", lines: ["task: scan workspace"] },
          { title: "Verification", lines: ["Ran focused checks."] },
        ],
      }),
    );

    expect(trace.status).toBe("complete");
    expect(trace.entries[0]).toMatchObject({
      label: "Completed",
      detail: "Workspace scan complete.",
      tone: "success",
    });
    expect(trace.entries.some((entry) => entry.label === "Verification")).toBe(
      true,
    );
  });
});