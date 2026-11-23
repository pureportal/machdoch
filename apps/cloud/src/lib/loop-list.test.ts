import { describe, expect, it } from "vitest";
import type { CloudLoopSummary } from "./cloud-loop-contract";
import {
  groupLoopsByTeam,
  loopSuccessRate,
  type LoopListQuery,
} from "./loop-list";

const executor = {
  placement: "automatic" as const,
  targetId: null,
  harness: "machdoch" as const,
  model: "",
  capabilities: [],
};

function loop(overrides: Partial<CloudLoopSummary>): CloudLoopSummary {
  return {
    id: "loop",
    kind: "automation",
    name: "Loop",
    description: "",
    teamId: "engineering",
    ownerId: "ada",
    ownerName: "Ada",
    enabled: true,
    killed: false,
    trigger: "Issue created",
    executor,
    runs: 0,
    succeededRuns: 0,
    finishedRuns: 0,
    costCents: 0,
    lastRunAt: null,
    nextRunAt: null,
    ...overrides,
  };
}

const teams = [
  { id: "cloud", name: "AlphaNET Cloud", parentId: "engineering" },
  { id: "engineering", name: "Software Engineering", parentId: null },
  { id: "design", name: "Design", parentId: null },
];

const now = new Date("2025-06-30T12:00:00Z");
const base: LoopListQuery = {
  scope: "all",
  userId: "ada",
  search: "",
  conditions: [],
  now,
};

const loops = [
  loop({ id: "a", name: "Triage bugs", teamId: "cloud", ownerId: "ada" }),
  loop({
    id: "b",
    name: "Changelog",
    description: "Maintain the changelog",
    teamId: "engineering",
    ownerId: "grace",
    enabled: false,
    lastRunAt: "2025-06-29T10:00:00.000Z",
  }),
  loop({ id: "c", name: "Reports", teamId: "design", ownerId: "ada" }),
];

describe("loop list", () => {
  it("groups loops by team with nested paths and keeps empty teams", () => {
    const groups = groupLoopsByTeam(loops, teams, base);
    expect(groups.map((group) => [group.path, group.loops.length])).toEqual([
      ["Design", 1],
      ["Software Engineering", 1],
      ["Software Engineering › AlphaNET Cloud", 1],
    ]);
    expect(
      groupLoopsByTeam(loops, teams, { ...base, scope: "mine" }).map(
        (group) => group.loops.map((item) => item.id),
      ),
    ).toEqual([["c"], [], ["a"]]);
  });

  it("searches and filters with the issue filter model", () => {
    const ids = (query: LoopListQuery) =>
      groupLoopsByTeam(loops, teams, query).flatMap((group) =>
        group.loops.map((item) => item.id),
      );
    expect(ids({ ...base, search: "changelog" })).toEqual(["b"]);
    expect(
      ids({
        ...base,
        conditions: [{ field: "creator", negated: false, values: ["me"] }],
      }),
    ).toEqual(["c", "a"]);
    expect(
      ids({
        ...base,
        conditions: [{ field: "automated", negated: true, values: ["yes"] }],
      }),
    ).toEqual(["b"]);
    expect(
      ids({
        ...base,
        conditions: [
          { field: "updated", negated: false, values: ["week"] },
          { field: "team", negated: false, values: ["engineering"] },
        ],
      }),
    ).toEqual(["b"]);
  });

  it("computes the 30-day success rate", () => {
    expect(loopSuccessRate(loop({ succeededRuns: 3, finishedRuns: 4 }))).toBe(
      75,
    );
    expect(loopSuccessRate(loop({}))).toBeNull();
  });
});
