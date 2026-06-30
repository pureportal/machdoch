import type { RalphFlowBlock } from "../ralph.ts";
import {
  doRalphLayoutBoundsContain,
  doRalphLayoutBoundsOverlap,
  getRalphLayoutNodeBounds,
  getRalphLayoutNodeBoundsAtPosition,
  getRalphLayoutNodeHeight,
  getRalphLayoutNodeWidth,
  mergeRalphLayoutBounds,
} from "./ralph-layout-node-bounds.helper.ts";

const startBlock: RalphFlowBlock = {
  id: "start",
  type: "START",
  title: "Start",
  position: { x: 10, y: 20 },
};

describe("ralph layout node sizing", () => {
  it("uses default dimensions for executable blocks and custom size when present", () => {
    expect(getRalphLayoutNodeWidth(startBlock)).toBe(270);
    expect(getRalphLayoutNodeHeight(startBlock)).toBe(140);
    expect(
      getRalphLayoutNodeWidth({
        ...startBlock,
        size: { width: 123, height: 456 },
      }),
    ).toBe(123);
    expect(
      getRalphLayoutNodeHeight({
        ...startBlock,
        size: { width: 123, height: 456 },
      }),
    ).toBe(456);
  });

  it("creates bounds at explicit positions and includes margins for stored positions", () => {
    expect(getRalphLayoutNodeBoundsAtPosition(startBlock, { x: 5, y: 6 })).toEqual({
      left: 5,
      right: 275,
      top: 6,
      bottom: 146,
    });
    expect(getRalphLayoutNodeBounds(startBlock)).toEqual({
      left: -26,
      right: 316,
      top: -16,
      bottom: 196,
    });
  });

  it("returns null bounds for unpositioned blocks", () => {
    const unpositionedStartBlock: RalphFlowBlock = {
      id: "start",
      type: "START",
      title: "Start",
    };

    expect(getRalphLayoutNodeBounds(unpositionedStartBlock)).toBeNull();
  });
});

describe("ralph layout bounds relationships", () => {
  it("detects overlap, containment, and empty merges", () => {
    const left = { left: 0, right: 10, top: 0, bottom: 10 };
    const overlapping = { left: 9, right: 20, top: 9, bottom: 20 };
    const touching = { left: 10, right: 20, top: 0, bottom: 10 };

    expect(doRalphLayoutBoundsOverlap(left, overlapping)).toBe(true);
    expect(doRalphLayoutBoundsOverlap(left, touching)).toBe(false);
    expect(doRalphLayoutBoundsContain({ left: 0, right: 20, top: 0, bottom: 20 }, left)).toBe(
      true,
    );
    expect(mergeRalphLayoutBounds([])).toBeNull();
    expect(mergeRalphLayoutBounds([left, overlapping])).toEqual({
      left: 0,
      right: 20,
      top: 0,
      bottom: 20,
    });
  });
});
