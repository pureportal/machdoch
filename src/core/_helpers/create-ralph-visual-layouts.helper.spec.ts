import type { RalphFlowBlock } from "../ralph.ts";
import {
  createRalphGroupLayout,
  createRalphLayoutGroupPositions,
  createRalphLayoutNotePositions,
} from "./create-ralph-visual-layouts.helper.ts";
import type { RalphLayoutGroupBlock, RalphLayoutNoteBlock } from "./ralph-layout-block-types.helper.ts";

const promptBlock = (
  id: string,
  position: { x: number; y: number },
  parentGroupId?: string,
): RalphFlowBlock => ({
  id,
  type: "PROMPT",
  title: id,
  prompt: id,
  position,
  ...(parentGroupId ? { parentGroupId } : {}),
});

const noteBlock = (
  id: string,
  values: Partial<RalphLayoutNoteBlock> = {},
): RalphLayoutNoteBlock => ({
  id,
  type: "NOTE",
  title: id,
  text: id,
  ...values,
});

const groupBlock = (
  id: string,
  childBlockIds: string[],
  values: Partial<RalphLayoutGroupBlock> = {},
): RalphLayoutGroupBlock => ({
  id,
  type: "GROUP",
  title: id,
  childBlockIds,
  ...values,
});

describe("createRalphLayoutNotePositions", () => {
  it("places notes after pinned block bounds", () => {
    const anchor = promptBlock("anchor", { x: 0, y: 0 });
    const blocksById = new Map([[anchor.id, anchor]]);
    const positionsByBlockId = new Map([[anchor.id, anchor.position ?? { x: 0, y: 0 }]]);

    createRalphLayoutNotePositions(
      [noteBlock("note", { pinnedBlockIds: ["anchor"] })],
      blocksById,
      positionsByBlockId,
      new Map(),
    );

    expect(positionsByBlockId.get("note")).toEqual({ x: 350, y: 0 });
  });

  it("stacks group notes beneath grouped peers", () => {
    const peer = promptBlock("peer", { x: 100, y: 200 }, "group");
    const blocksById = new Map([[peer.id, peer]]);
    const positionsByBlockId = new Map([[peer.id, peer.position ?? { x: 0, y: 0 }]]);

    createRalphLayoutNotePositions(
      [noteBlock("note", { parentGroupId: "group" })],
      blocksById,
      positionsByBlockId,
      new Map([["group", ["peer", "note"]]]),
    );

    expect(positionsByBlockId.get("note")).toEqual({ x: 100, y: 376 });
  });
});

describe("createRalphLayoutGroupPositions", () => {
  it("wraps child bounds with padding and preserves collapsed height", () => {
    expect(
      createRalphGroupLayout(
        groupBlock("group", [], { collapsed: true }),
        { left: 10, right: 500, top: 20, bottom: 260 },
      ),
    ).toEqual({
      position: { x: -60, y: -68 },
      size: { width: 720, height: 420 },
    });
  });

  it("falls back to existing group layout when a group has no child bounds", () => {
    const group = groupBlock("group", [], {
      position: { x: 10, y: 20 },
      size: { width: 800, height: 500 },
    });
    const layouts = createRalphLayoutGroupPositions(
      [group],
      new Map([[group.id, group]]),
      new Map(),
      new Map([["group", []]]),
    );

    expect(layouts.get("group")).toEqual({
      position: { x: 10, y: 20 },
      size: { width: 800, height: 500 },
    });
  });
});
