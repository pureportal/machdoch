import { describe, expect, it } from "vitest";
import type { RecentDesktopTaskResult } from "../../runtime";
import { readRalphTaskCompletion } from "./ralph-task-completion.helper";

const createTask = (execution: unknown): RecentDesktopTaskResult => ({
  id: "task-1",
  kind: "ralph",
  workspaceRoot: "/repo",
  arguments: ["run", "flow-1"],
  startedAt: 1,
  finishedAt: 2,
  outcome: { status: "succeeded", response: { execution } },
});

describe("RALPH task completion recovery", () => {
  it("recovers a background run's final summary and durable record identity", () => {
    expect(
      readRalphTaskCompletion(
        createTask({
          run: { runId: "run-1", summary: "Verification unavailable" },
        }),
      ),
    ).toEqual({ runId: "run-1", summary: "Verification unavailable" });
  });

  it.each(["created", "blocked"])(
    "recovers the %s generation outcome",
    (status) => {
      expect(
        readRalphTaskCompletion(
          createTask({ status, summary: "Generation result" }),
        ),
      ).toEqual({ generationStatus: status, summary: "Generation result" });
    },
  );

  it("retains startup failures without reporting that the flow finished successfully", () => {
    const task = createTask(null);
    task.outcome = {
      status: "failed",
      failure: { kind: "runtime", message: "The CLI could not start." },
    };
    expect(readRalphTaskCompletion(task)).toEqual({
      summary: "The CLI could not start.",
      generationStatus: "failed",
    });
  });

  it("rejects unrelated tasks and missing terminal payloads", () => {
    expect(
      readRalphTaskCompletion({ ...createTask({}), kind: "desktop" }),
    ).toBeNull();
    expect(readRalphTaskCompletion(createTask(null))).toBeNull();
    expect(readRalphTaskCompletion(createTask({ run: {} }))).toBeNull();
  });
});
