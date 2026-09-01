import { describe, expect, it } from "vitest";
import type { RalphBlockExecutionResult, RalphFlowBlock } from "../ralph.js";
import { collectActiveRalphJsonTaskClaims } from "./ralph-json-task-claims.helper.js";

const blocks: RalphFlowBlock[] = [
  {
    id: "select",
    type: "UTILITY",
    title: "Select",
    utility: { type: "SELECT_JSON_TASK" },
  },
  {
    id: "mark",
    type: "UTILITY",
    title: "Mark",
    utility: { type: "MARK_JSON_TASK" },
  },
  {
    id: "archive",
    type: "UTILITY",
    title: "Archive",
    utility: { type: "ARCHIVE_FILE" },
  },
];

const result = (
  blockId: string,
  output: string,
  data: Record<string, unknown>,
): RalphBlockExecutionResult => ({
  blockId,
  output,
  status: "completed",
  attempt: 1,
  summary: output,
  data,
});

describe("RALPH JSON task claims", () => {
  it("keeps only selected tasks whose lifecycle remains active", () => {
    const claims = collectActiveRalphJsonTaskClaims(blocks, [
      result("select", "SELECTED", {
        path: "C:\\workspace\\tasks.json",
        jsonPath: "tasks",
        taskIds: ["one", "two"],
      }),
      result("mark", "SUCCESS", {
        path: "C:\\workspace\\tasks.json",
        jsonPath: "tasks",
        taskIds: ["one"],
        status: "completed",
      }),
      result("mark", "SUCCESS", {
        path: "C:\\workspace\\tasks.json",
        jsonPath: "tasks",
        taskIds: ["two"],
        status: "repairing",
      }),
    ]);

    expect(claims).toHaveLength(1);
    expect([...claims[0]!.taskIds]).toEqual(["two"]);
  });

  it("retires a task claim after deferral and permits a later selection", () => {
    const claims = collectActiveRalphJsonTaskClaims(blocks, [
      result("select", "SELECTED", {
        path: "/workspace/tasks.json",
        jsonPath: "tasks",
        taskIds: ["one"],
      }),
      result("mark", "SUCCESS", {
        path: "/workspace/tasks.json",
        jsonPath: "tasks",
        taskIds: ["one"],
        status: "deferred",
      }),
      result("select", "SELECTED", {
        path: "/workspace/tasks.json",
        jsonPath: "tasks",
        taskIds: ["one"],
      }),
    ]);

    expect([...claims[0]!.taskIds]).toEqual(["one"]);
  });

  it("retires every claim for an explicitly archived lifecycle file", () => {
    const claims = collectActiveRalphJsonTaskClaims(blocks, [
      result("select", "SELECTED", {
        path: "C:\\Workspace\\tasks.json",
        jsonPath: "tasks",
        taskIds: ["one"],
      }),
      result("archive", "SUCCESS", {
        from: "C:\\Workspace\\tasks.json",
        to: "C:\\Workspace\\archive\\tasks.json",
      }),
    ]);

    expect(claims).toEqual([]);
  });

  it("tracks path and JSON path as separate identity fields", () => {
    const claims = collectActiveRalphJsonTaskClaims(blocks, [
      result("select", "SELECTED", {
        path: "/workspace/tasks\0nested.json",
        jsonPath: "tasks",
        taskIds: ["one"],
      }),
      result("select", "SELECTED", {
        path: "/workspace/tasks",
        jsonPath: "nested.json\0tasks",
        taskIds: ["two"],
      }),
    ]);

    expect(claims).toHaveLength(2);
    expect(claims.map((claim) => [...claim.taskIds])).toEqual([
      ["one"],
      ["two"],
    ]);
  });
});
