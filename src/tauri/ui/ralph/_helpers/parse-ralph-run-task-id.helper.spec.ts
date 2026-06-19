import {
  createRalphRunTaskId,
  getRalphArgumentValue,
  getRalphTaskAction,
  getRalphTaskFlowReference,
  getRalphTaskFlowScope,
  normalizeWorkspaceForTaskComparison,
  parseRalphRunTaskId,
} from "./parse-ralph-run-task-id.helper";

describe("Ralph run task id helpers", () => {
  it("creates deterministic task ids with sanitized flow aliases", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_781_872_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(createRalphRunTaskId(" My Flow! ")).toBe(
      "ralph-my-flow-1781872000000-i",
    );
  });

  it("falls back to a generic flow alias when the source flow id is empty", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_781_872_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(createRalphRunTaskId("   ")).toBe("ralph-flow-1781872000000-i");
  });

  it("parses valid task ids with hyphenated flow ids", () => {
    expect(parseRalphRunTaskId("ralph-release-flow-1781872000000-abc123")).toEqual({
      flowId: "release-flow",
      startedAt: 1_781_872_000_000,
    });
  });

  it.each([
    "",
    "ralph-release-flow-abc-abc123",
    "ralph--1781872000000-abc123",
    "task-release-flow-1781872000000-abc123",
    "ralph-release-flow-1781872000000-",
  ])("rejects invalid task id %s", (taskId) => {
    expect(parseRalphRunTaskId(taskId)).toBeNull();
  });

  it("normalizes workspace roots for cross-platform task comparison", () => {
    expect(normalizeWorkspaceForTaskComparison(" C:\\Repo\\\\Machdoch ")).toBe(
      "c:/repo/machdoch",
    );
    expect(normalizeWorkspaceForTaskComparison("/Users/Me//Machdoch")).toBe(
      "/users/me/machdoch",
    );
    expect(normalizeWorkspaceForTaskComparison(null)).toBe("");
    expect(normalizeWorkspaceForTaskComparison(undefined)).toBe("");
  });

  it("reads trimmed argument values and returns null for missing or empty values", () => {
    expect(getRalphArgumentValue(["create", "--name", " Release Flow "], "--name")).toBe(
      "Release Flow",
    );
    expect(getRalphArgumentValue(["create", "--name", "   "], "--name")).toBeNull();
    expect(getRalphArgumentValue(["create"], "--name")).toBeNull();
  });

  it("derives task actions and flow references from run and create commands", () => {
    expect(getRalphTaskAction({ arguments: [" run "] })).toBe("run");
    expect(getRalphTaskAction({ arguments: [] })).toBeNull();
    expect(getRalphTaskAction({ arguments: ["   "] })).toBeNull();

    expect(
      getRalphTaskFlowReference({ arguments: ["run", " release-flow "] }),
    ).toBe("release-flow");
    expect(
      getRalphTaskFlowReference({
        arguments: ["create", "--name", " Release Flow "],
      }),
    ).toBe("Release Flow");
    expect(getRalphTaskFlowReference({ arguments: ["inspect"] })).toBeNull();
  });

  it("normalizes task flow scopes with workspace defaults for invalid values", () => {
    expect(getRalphTaskFlowScope({ arguments: ["run", "flow", "--scope", "user"] })).toBe(
      "user",
    );
    expect(
      getRalphTaskFlowScope({ arguments: ["run", "flow", "--scope", "workspace"] }),
    ).toBe("workspace");
    expect(getRalphTaskFlowScope({ arguments: ["run", "flow"] })).toBe("workspace");
    expect(getRalphTaskFlowScope({ arguments: ["run", "flow", "--scope", "team"] })).toBe(
      "workspace",
    );
  });
});
