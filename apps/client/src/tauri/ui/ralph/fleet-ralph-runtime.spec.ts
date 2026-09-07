import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadFleetRalphSnapshot } from "./fleet-ralph";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  isTauri: () => true,
}));

beforeEach(() => {
  invoke.mockReset();
});

describe("Fleet Ralph desktop queries", () => {
  it("loads both scopes with one CLI request and then reads active tasks natively", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "get_active_desktop_tasks") return [];
      if (command !== "run_ralph_command")
        throw new Error(`Unexpected command: ${command}`);
      return {
        workspaceRoot: "C:/repo",
        scopes: (["workspace", "user"] as const).map((scope) => ({
          scope,
          flows: [
            {
              id: scope,
              name: scope,
              blockCount: 1,
              edgeCount: 0,
              variables: [],
            },
          ],
          runs: [],
        })),
      };
    });

    const snapshot = await loadFleetRalphSnapshot("C:/repo");

    expect(invoke.mock.calls).toEqual([
      [
        "run_ralph_command",
        { request: { workspaceRoot: "C:/repo", arguments: ["snapshot"] } },
      ],
      ["get_active_desktop_tasks"],
    ]);
    expect(snapshot.flows.map(({ scope }) => scope).sort()).toEqual([
      "user",
      "workspace",
    ]);
  });
});
