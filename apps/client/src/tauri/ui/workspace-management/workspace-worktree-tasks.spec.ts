import { describe, expect, it } from "vitest";
import type { RalphRunSummary } from "../../../core/ralph.js";
import { matchWorktreeTasks } from "./workspace-worktree-tasks";

const run = (overrides: Partial<RalphRunSummary>): RalphRunSummary => ({
  id: "run-1",
  path: "C:\\Work\\.machdoch\\local\\state\\ralph\\runs\\run-1",
  createdAt: "2026-11-20T10:00:00.000Z",
  flowId: "refactor",
  flowName: "Refactor",
  status: "completed",
  recoverable: false,
  summary: "",
  blockCount: 1,
  eventCount: 1,
  ...overrides,
});

describe("worktree tasks", () => {
  it("links each worktree to the newest run that executed inside it", () => {
    const tasks = matchWorktreeTasks(
      [
        "C:\\Work",
        "C:\\.machdoch-ralph-worktrees\\abc",
        "C:\\.machdoch-ralph-worktrees\\def",
      ],
      [
        {
          scope: "workspace",
          runs: [
            run({
              id: "old",
              worktreePath: "c:/.machdoch-ralph-worktrees/abc/apps/api",
            }),
            run({
              id: "new",
              createdAt: "2026-11-21T10:00:00.000Z",
              worktreePath: "C:\\.machdoch-ralph-worktrees\\abc\\apps\\api",
              status: "running",
            }),
            run({
              id: "elsewhere",
              worktreePath: "C:\\.machdoch-ralph-worktrees\\abcdef",
            }),
          ],
        },
        {
          scope: "user",
          runs: [
            run({
              id: "global",
              flowName: "Security",
              worktreePath: "C:\\.machdoch-ralph-worktrees\\def",
            }),
          ],
        },
      ],
    );
    expect(tasks.get("C:\\Work")).toBeUndefined();
    expect(tasks.get("C:\\.machdoch-ralph-worktrees\\abc")).toMatchObject({
      runId: "new",
      scope: "workspace",
    });
    expect(tasks.get("C:\\.machdoch-ralph-worktrees\\def")).toMatchObject({
      runId: "global",
      flowName: "Security",
      scope: "user",
    });
  });
});
