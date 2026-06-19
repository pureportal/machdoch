import type {
  RalphFlow,
  RalphFlowBlock,
  RalphPosition,
} from "../../../../core/ralph.js";
import {
  RALPH_BLOCK_FALLBACK_HEIGHT,
  RALPH_CANVAS_X_GAP,
  RALPH_CANVAS_Y_GAP,
  RALPH_GROUP_COLLAPSED_HEIGHT,
  RALPH_GROUP_DEFAULT_SIZE,
  RALPH_NOTE_DEFAULT_SIZE,
  avoidReservedCleanLayoutBounds,
  collectCollapsedGroupHiddenBlockIds,
  createDerivedGroupChildrenById,
  doCanvasBoundsOverlap,
  flowToEdges,
  flowToNodes,
  forceRalphFlowLayout,
  getBlockFallbackWidth,
  getCanvasBlockBounds,
  getCanvasBlockSize,
  getDefaultCanvasPosition,
  getSelectableRouteTargets,
  isPointInsideBounds,
  normalizeDerivedGroupMembership,
  translateCanvasBounds,
} from "./ralph-canvas-layout.helper";

const createFlow = (overrides: Partial<RalphFlow> = {}): RalphFlow => ({
  schemaVersion: 1,
  id: "layout-flow",
  alias: "layout-flow",
  name: "Layout Flow",
  blocks: [
    { id: "start", type: "START", title: "Start" },
    { id: "end", type: "END", title: "End", status: "success" },
  ],
  edges: [
    {
      id: "start-success-end",
      from: "start",
      fromOutput: "SUCCESS",
      to: "end",
    },
  ],
  ...overrides,
});

const noteBlock = (
  overrides: Partial<Extract<RalphFlowBlock, { type: "NOTE" }>> = {},
): RalphFlowBlock => ({
  id: "note",
  type: "NOTE",
  title: "Note",
  text: "Context",
  ...overrides,
});

const groupBlock = (
  overrides: Partial<Extract<RalphFlowBlock, { type: "GROUP" }>> = {},
): RalphFlowBlock => ({
  id: "group",
  type: "GROUP",
  title: "Group",
  childBlockIds: [],
  ...overrides,
});

const promptBlock = (
  overrides: Partial<Extract<RalphFlowBlock, { type: "PROMPT" }>> = {},
): RalphFlowBlock => ({
  id: "prompt",
  type: "PROMPT",
  title: "Prompt",
  prompt: "Summarize.",
  ...overrides,
});

describe("Ralph canvas layout helpers", () => {
  it("derives default grid positions and fallback sizes", () => {
    expect(getDefaultCanvasPosition(0)).toEqual({ x: 80, y: 120 });
    expect(getDefaultCanvasPosition(1)).toEqual({
      x: 80 + RALPH_CANVAS_X_GAP,
      y: 120,
    });
    expect(getDefaultCanvasPosition(2)).toEqual({
      x: 80,
      y: 120 + RALPH_CANVAS_Y_GAP,
    });

    expect(getCanvasBlockSize(noteBlock())).toEqual(RALPH_NOTE_DEFAULT_SIZE);
    expect(getCanvasBlockSize(groupBlock())).toEqual(RALPH_GROUP_DEFAULT_SIZE);
    expect(getCanvasBlockSize(promptBlock())).toEqual({
      width: getBlockFallbackWidth(promptBlock()),
      height: RALPH_BLOCK_FALLBACK_HEIGHT,
    });
    expect(
      getCanvasBlockSize({
        id: "utility",
        type: "UTILITY",
        title: "Fetch",
        utility: { type: "HTTP_FETCH", url: "https://example.test" },
      }),
    ).toEqual({ width: 288, height: RALPH_BLOCK_FALLBACK_HEIGHT });
  });

  it("calculates bounds, point inclusion, overlap, and translation boundaries", () => {
    const block = promptBlock({
      position: { x: 10, y: 20 },
      size: { width: 100, height: 50 },
    });
    const bounds = getCanvasBlockBounds(block, 0);

    expect(bounds).toEqual({
      left: 10,
      top: 20,
      right: 110,
      bottom: 70,
      centerX: 60,
      centerY: 45,
    });
    expect(isPointInsideBounds(10, 20, bounds)).toBe(true);
    expect(isPointInsideBounds(110, 70, bounds)).toBe(true);
    expect(isPointInsideBounds(111, 70, bounds)).toBe(false);
    expect(doCanvasBoundsOverlap(bounds, translateCanvasBounds(bounds, 99, 0))).toBe(true);
    expect(doCanvasBoundsOverlap(bounds, translateCanvasBounds(bounds, 100, 0))).toBe(false);
    expect(translateCanvasBounds(bounds, -5, 10)).toMatchObject({
      left: 5,
      top: 30,
      centerX: 55,
      centerY: 55,
    });
  });

  it("moves clean layout positions to avoid reserved visual blocks", () => {
    const flow = createFlow({
      blocks: [
        noteBlock({ position: { x: 0, y: 0 } }),
        promptBlock({ id: "layout", position: { x: 10, y: 10 } }),
      ],
      edges: [],
    });
    const shifted = avoidReservedCleanLayoutBounds(
      flow,
      new Set(["layout"]),
      new Map<string, RalphPosition>([["layout", { x: 10, y: 10 }]]),
    );

    expect(shifted.get("layout")).toEqual({
      x: RALPH_NOTE_DEFAULT_SIZE.width + 96,
      y: 10,
    });
    expect(
      avoidReservedCleanLayoutBounds(
        createFlow({ blocks: [promptBlock({ id: "layout" })], edges: [] }),
        new Set(["layout"]),
        new Map<string, RalphPosition>([["layout", { x: 10, y: 10 }]]),
      ).get("layout"),
    ).toEqual({ x: 10, y: 10 });
  });

  it("derives group children from explicit membership, parent ids, and placed geometry", () => {
    const flow = createFlow({
      blocks: [
        groupBlock({
          position: { x: 0, y: 0 },
          size: { width: 300, height: 240 },
        }),
        promptBlock({
          id: "inside",
          position: { x: 40, y: 40 },
        }),
        promptBlock({
          id: "parented",
          parentGroupId: "group",
          position: { x: 400, y: 400 },
        }),
        promptBlock({
          id: "outside",
          position: { x: 500, y: 500 },
        }),
      ],
      edges: [],
    });

    expect(createDerivedGroupChildrenById(flow).get("group")).toEqual([
      "inside",
      "parented",
    ]);

    expect(
      createDerivedGroupChildrenById(
        createFlow({
          blocks: [
            groupBlock({ childBlockIds: ["explicit"] }),
            promptBlock({ id: "explicit" }),
          ],
          edges: [],
        }),
      ).get("group"),
    ).toEqual(["explicit"]);
  });

  it("normalizes group membership and preserves unchanged flow references", () => {
    const flow = createFlow({
      blocks: [
        groupBlock({
          position: { x: 0, y: 0 },
          size: { width: 300, height: 240 },
        }),
        promptBlock({ id: "inside", position: { x: 40, y: 40 } }),
      ],
      edges: [],
    });
    const normalized = normalizeDerivedGroupMembership(flow);

    expect(normalized).not.toBe(flow);
    expect(normalized.blocks[0]).toMatchObject({
      id: "group",
      childBlockIds: ["inside"],
    });
    expect(normalizeDerivedGroupMembership(normalized)).toBe(normalized);
  });

  it("collects nested hidden ids for collapsed groups", () => {
    const flow = createFlow({
      blocks: [
        groupBlock({
          collapsed: true,
          childBlockIds: ["nested"],
        }),
        groupBlock({
          id: "nested",
          childBlockIds: ["child"],
        }),
        promptBlock({ id: "child" }),
      ],
      edges: [],
    });
    const childrenByGroupId = new Map<string, string[]>([
      ["group", ["nested"]],
      ["nested", ["child"]],
    ]);

    expect([...collectCollapsedGroupHiddenBlockIds(flow, childrenByGroupId)]).toEqual([
      "nested",
      "child",
    ]);
  });

  it("converts flows to canvas nodes with issues, selection, activity, and hidden groups", () => {
    const flow = createFlow({
      blocks: [
        groupBlock({
          collapsed: true,
          childBlockIds: ["prompt"],
          size: { width: 480, height: 320 },
        }),
        promptBlock({ parentGroupId: "group" }),
      ],
      edges: [],
    });
    const nodes = flowToNodes(
      flow,
      [{ level: "error", message: "Missing route", blockId: "prompt" }],
      "prompt",
      "prompt",
    );

    expect(nodes[0]).toMatchObject({
      id: "group",
      zIndex: -1,
      style: { width: 480, height: RALPH_GROUP_COLLAPSED_HEIGHT },
      data: { derivedChildIds: ["prompt"] },
    });
    expect(nodes[1]).toMatchObject({
      id: "prompt",
      hidden: true,
      data: {
        issueCount: 1,
        active: true,
        selected: true,
        hiddenByCollapsedGroup: true,
      },
    });
  });

  it("converts flows to canvas edges with route styling and hidden collapsed-group edges", () => {
    const flow = createFlow({
      blocks: [
        groupBlock({
          collapsed: true,
          childBlockIds: ["prompt"],
        }),
        promptBlock({ parentGroupId: "group" }),
        { id: "end", type: "END", title: "End", status: "failed" },
      ],
      edges: [
        {
          id: "prompt-error-end",
          from: "prompt",
          fromOutput: "ERROR",
          to: "end",
        },
      ],
    });
    const edges = flowToEdges(flow, "prompt-error-end", "prompt");

    expect(edges).toEqual([
      expect.objectContaining({
        id: "prompt-error-end",
        source: "prompt",
        sourceHandle: "ERROR",
        target: "end",
        selected: true,
        hidden: true,
        className: "ralph-route-edge--connected ralph-route-edge--selected",
        data: { output: "ERROR" },
        style: { stroke: "#f87171", strokeWidth: 2.8 },
      }),
    ]);
  });

  it("filters route targets to executable and terminal blocks", () => {
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        noteBlock(),
        groupBlock(),
        promptBlock(),
        { id: "end", type: "END", title: "End", status: "success" },
      ],
      edges: [],
    });

    expect(getSelectableRouteTargets(flow).map((block) => block.id)).toEqual([
      "start",
      "prompt",
      "end",
    ]);
  });

  it("forces clean layout for executable blocks while preserving visual block positions", () => {
    const note = noteBlock({
      position: { x: 0, y: 0 },
    });
    const flow = createFlow({
      blocks: [
        note,
        { id: "start", type: "START", title: "Start" },
        promptBlock({ id: "prompt" }),
        { id: "end", type: "END", title: "End", status: "success" },
      ],
      edges: [
        {
          id: "start-success-prompt",
          from: "start",
          fromOutput: "SUCCESS",
          to: "prompt",
        },
        {
          id: "prompt-success-end",
          from: "prompt",
          fromOutput: "SUCCESS",
          to: "end",
        },
      ],
    });
    const arranged = forceRalphFlowLayout(flow);
    const noteAfterLayout = arranged.blocks.find((block) => block.id === "note");
    const arrangedExecutableBlocks = arranged.blocks.filter(
      (block) => block.type !== "NOTE" && block.type !== "GROUP",
    );

    expect(noteAfterLayout).toEqual(note);
    expect(
      arrangedExecutableBlocks.every((block) => block.position !== undefined),
    ).toBe(true);
    expect(
      arrangedExecutableBlocks.every(
        (block) =>
          block.position !== undefined &&
          block.position.x >= RALPH_NOTE_DEFAULT_SIZE.width + 96,
      ),
    ).toBe(true);
  });
});
