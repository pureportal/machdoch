import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSchedulerActivity } from "./scheduler-activity-runtime";

const { invoke, isTauri } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri }));

beforeEach(() => {
  invoke.mockReset();
  isTauri.mockReset().mockReturnValue(true);
});

describe("scheduler activity bridge", () => {
  it("uses one native request for five workspaces and preserves partial failures", async () => {
    const snapshot = [
      { workspaceRoot: "first", runs: [{ id: "run-1", status: "running" }] },
      { workspaceRoot: "second", error: "Workspace unavailable" },
    ];
    invoke.mockResolvedValue(snapshot);
    await expect(
      loadSchedulerActivity([
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
        "first",
      ]),
    ).resolves.toEqual(snapshot);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("get_scheduler_activity", {
      workspaceRoots: ["first", "second", "third", "fourth", "fifth"],
    });
  });

  it("does not invoke desktop commands in the browser or for empty workspaces", async () => {
    await expect(loadSchedulerActivity([])).resolves.toEqual([]);
    isTauri.mockReturnValue(false);
    await expect(loadSchedulerActivity(["first"])).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("propagates read failures without launching a CLI retry", async () => {
    invoke.mockRejectedValue("Read timed out");
    await expect(loadSchedulerActivity(["first"])).rejects.toBe(
      "Read timed out",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
