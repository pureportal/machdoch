import { describe, expect, it } from "vitest";
import { slowestWorkspaceGitCalls } from "./workspace-git-call-log";

const call = (
  args: string[],
  durationMs: number,
  queuedMs = 0,
  repository = "C:\\work\\api",
) => ({
  repository,
  arguments: args,
  priority: "interactive" as const,
  startedAt: 0,
  queuedMs,
  durationMs,
  success: true,
});

describe("workspace Git call log", () => {
  it("lists the slowest calls including their queue time", () => {
    const slow = slowestWorkspaceGitCalls(
      [
        call(["status"], 40),
        call(["-c", "core.fsmonitor=true", "diff", "--numstat"], 90.4),
        call(["log"], 20, 100, "/home/me/app/"),
      ],
      2,
    );
    expect(slow).toEqual([
      {
        command: "log",
        repository: "app",
        durationMs: 20,
        queuedMs: 100,
        priority: "interactive",
        success: true,
      },
      {
        command: "diff --numstat",
        repository: "api",
        durationMs: 90,
        queuedMs: 0,
        priority: "interactive",
        success: true,
      },
    ]);
  });
});
