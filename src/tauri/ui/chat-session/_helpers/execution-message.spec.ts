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
    ...(overrides.memoryUpdates
      ? { memoryUpdates: overrides.memoryUpdates }
      : {}),
  };
};

describe("execution-message helpers", () => {
  it("creates a fallback execution markdown string from status and summary", () => {
    expect(
      createFallbackExecutionMarkdown(
        createExecution({
          status: "blocked",
          summary: "Needs machdoch mode.",
        }),
      ),
    ).toBe("**Blocked.** Needs machdoch mode.");
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

  it("uses an unstructured assistant answer section before generic fallback content", () => {
    expect(
      getExecutionMessageContent(
        createExecution({
          status: "blocked",
          summary:
            "The model-driven execution stopped without submitting a structured final response.",
          outputSections: [
            {
              title: "Agent answer",
              lines: [
                "1: Fetched and summarized the current weather for Sulz am Neckar.",
              ],
            },
          ],
        }),
      ),
    ).toBe("Fetched and summarized the current weather for Sulz am Neckar.");
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
          {
            title: "Task context",
            audience: "internal",
            lines: ["task: scan workspace"],
          },
          {
            title: "Tool trace",
            audience: "internal",
            lines: [
              'tool_call: read_file({"path":"README.md","startLine":1,"endLine":20})',
              "read_file(README.md, 1-20)",
            ],
          },
          {
            title: "Verification",
            tone: "success",
            lines: ["Ran focused checks."],
          },
        ],
      }),
    );

    expect(trace.status).toBe("complete");
    expect(trace.entries[0]).toMatchObject({
      label: "Completed",
      detail: "Workspace scan complete.",
      tone: "success",
    });
    expect(
      trace.entries.some((entry) => entry.label === "Task context"),
    ).toBe(false);
    expect(
      trace.entries.some((entry) => entry.label === "Tool trace"),
    ).toBe(false);
    expect(
      trace.entries.some(
        (entry) => entry.label === "Verification" && entry.tone === "success",
      ),
    ).toBe(true);
  });
});
