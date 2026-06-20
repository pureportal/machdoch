import type { RalphFlow } from "../ralph.ts";
import { shouldNormalizeRalphFlowLayout } from "./should-normalize-ralph-flow-layout.helper.ts";

const createFlow = (blocks: RalphFlow["blocks"]): RalphFlow => ({
  schemaVersion: 1,
  id: "layout-normalization",
  name: "Layout Normalization",
  blocks,
  edges: [],
});

describe("shouldNormalizeRalphFlowLayout", () => {
  it("returns false for empty flows and already positioned non-overlapping blocks", () => {
    expect(shouldNormalizeRalphFlowLayout(createFlow([]))).toBe(false);
    expect(
      shouldNormalizeRalphFlowLayout(
        createFlow([
          {
            id: "start",
            type: "START",
            title: "Start",
            position: { x: 0, y: 0 },
          },
          {
            id: "end",
            type: "END",
            title: "End",
            status: "success",
            position: { x: 500, y: 0 },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("returns true for missing executable positions", () => {
    expect(
      shouldNormalizeRalphFlowLayout(
        createFlow([
          {
            id: "start",
            type: "START",
            title: "Start",
          },
        ]),
      ),
    ).toBe(true);
  });

  it("returns true for overlapping executable blocks", () => {
    expect(
      shouldNormalizeRalphFlowLayout(
        createFlow([
          {
            id: "start",
            type: "START",
            title: "Start",
            position: { x: 0, y: 0 },
          },
          {
            id: "prompt",
            type: "PROMPT",
            title: "Prompt",
            prompt: "Continue?",
            position: { x: 10, y: 10 },
          },
        ]),
      ),
    ).toBe(true);
  });

  it("returns true for group layout mismatches", () => {
    expect(
      shouldNormalizeRalphFlowLayout(
        createFlow([
          {
            id: "group",
            type: "GROUP",
            title: "Group",
            childBlockIds: [],
            position: { x: 0, y: 0 },
            size: { width: 500, height: 500 },
          },
          {
            id: "start",
            type: "START",
            title: "Start",
            parentGroupId: "group",
            position: { x: 50, y: 50 },
          },
        ]),
      ),
    ).toBe(true);
  });

  it("returns true for unpositioned groups", () => {
    expect(
      shouldNormalizeRalphFlowLayout(
        createFlow([
          {
            id: "group",
            type: "GROUP",
            title: "Group",
            childBlockIds: [],
          },
        ]),
      ),
    ).toBe(true);
  });
});
