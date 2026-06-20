import type { RalphFlow, RalphFlowBlock } from "../ralph.ts";
import {
  createRalphLayoutChildGroupIds,
  createRalphLayoutGroupChildIds,
  createRalphNormalizedGroupChildIds,
} from "./create-ralph-layout-group-child-ids.helper.ts";

const startBlock = (
  id: string,
  parentGroupId?: string,
): RalphFlowBlock => ({
  id,
  type: "START",
  title: id,
  ...(parentGroupId ? { parentGroupId } : {}),
});

const groupBlock = (
  id: string,
  childBlockIds: string[],
  parentGroupId?: string,
): RalphFlowBlock => ({
  id,
  type: "GROUP",
  title: id,
  childBlockIds,
  ...(parentGroupId ? { parentGroupId } : {}),
});

const flowWithBlocks = (blocks: RalphFlowBlock[]): RalphFlow => ({
  schemaVersion: 1,
  id: "flow",
  name: "Flow",
  blocks,
  edges: [],
});

describe("createRalphLayoutGroupChildIds", () => {
  it("combines declared and parent-derived children in flow order", () => {
    const children = createRalphLayoutGroupChildIds(
      flowWithBlocks([
        groupBlock("outer", ["declared", "missing", "outer"]),
        startBlock("declared"),
        startBlock("derived", "outer"),
      ]),
    );

    expect(children.get("outer")).toEqual(["declared", "derived"]);
  });

  it("keeps groups with no valid children", () => {
    const children = createRalphLayoutGroupChildIds(
      flowWithBlocks([groupBlock("empty", ["missing", "empty"])]),
    );

    expect(children.get("empty")).toEqual([]);
  });
});

describe("createRalphNormalizedGroupChildIds", () => {
  it("deduplicates declared and derived children without adding the group itself", () => {
    const group = groupBlock("group", ["a", "group", "a"]);

    expect(createRalphNormalizedGroupChildIds(group, ["b", "a", "group"])).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("createRalphLayoutChildGroupIds", () => {
  it("inverts child membership while preserving parent order", () => {
    const groupIds = createRalphLayoutChildGroupIds(
      new Map([
        ["outer", ["shared", "outer-only"]],
        ["inner", ["shared"]],
      ]),
    );

    expect(groupIds.get("shared")).toEqual(["outer", "inner"]);
    expect(groupIds.get("outer-only")).toEqual(["outer"]);
  });
});
