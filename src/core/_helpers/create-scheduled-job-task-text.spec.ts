import type { ScheduledJob } from "../scheduler.js";
import { createScheduledJobTaskText } from "./create-scheduled-job-task-text.helper.ts";

const createJob = (
  target: Partial<ScheduledJob["target"]>,
): ScheduledJob =>
  ({
    id: "job_1",
    name: "Daily",
    status: "active",
    triggers: [],
    target: {
      type: "prompt",
      workspaceRoot: "/workspace",
      prompt: "Run it",
      contextPaths: [],
      imagePaths: [],
      contextPacks: [],
      macros: [],
      ...target,
    },
    missedRunPolicy: "enqueue-latest",
    missedRunGraceMs: 60_000,
    retry: {
      maxAttempts: 1,
      factor: 2,
      minTimeoutMs: 1_000,
      maxTimeoutMs: 60_000,
      randomize: true,
    },
    queue: {
      concurrencyKey: "job_1",
      concurrencyLimit: 1,
    },
    historyLimit: 100,
    maxCatchUpRuns: 100,
    createdAt: 1,
    updatedAt: 1,
  }) satisfies ScheduledJob;

describe("createScheduledJobTaskText", () => {
  it("returns trimmed prompt text for Ralph flow targets", () => {
    const job = createJob({
      type: "ralph-flow",
      prompt: "  Run flow  ",
      ralphFlow: {
        scope: "workspace",
        id: "flow",
        params: {},
      },
    });

    expect(createScheduledJobTaskText(job)).toBe("Run flow");
  });

  it("combines context packs, macros, prompt, and direct context paths", () => {
    const job = createJob({
      prompt: "Review the workspace.",
      contextPaths: ["src", "README.md"],
      contextPacks: [
        {
          name: "Release",
          instructions: "Check {area}",
          prompt: "Summarize {area}",
          contextPaths: ["docs/release.md"],
          variableValues: { area: "changes" },
        },
      ],
      macros: [
        {
          name: "smoke",
          promptInvocation: "/smoke --fast",
          inputValues: { browser: "chromium" },
        },
      ],
    });

    expect(createScheduledJobTaskText(job)).toBe(
      [
        "## Context Pack: Release",
        "",
        "### Instructions",
        "Check changes",
        "",
        "### Prompt",
        "Summarize changes",
        "",
        "### Context Paths",
        'Use this path: "docs/release.md"',
        "",
        "## Saved Macro: smoke",
        "",
        "Run this saved prompt or macro invocation:",
        "/smoke --fast",
        "",
        "Inputs:",
        "- browser: chromium",
        "",
        "Review the workspace.",
        "",
        "Use these paths:",
        '- path: "src"',
        '- path: "README.md"',
      ].join("\n"),
    );
  });

  it("omits empty prompt sections and returns an empty string for empty prompt jobs", () => {
    expect(createScheduledJobTaskText(createJob({ prompt: "   " }))).toBe("");
  });
});
