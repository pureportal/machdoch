import type { RalphFlow } from "../ralph.ts";
import { hasRalphLayoutGroupMismatch } from "./has-ralph-layout-group-mismatch.helper.ts";

const createFlow = (blocks: RalphFlow["blocks"]): RalphFlow => ({
  schemaVersion: 1,
  id: "layout-groups",
  name: "Layout Groups",
  blocks,
  edges: [],
});

describe("hasRalphLayoutGroupMismatch", () => {
  it("returns false for empty flows and groups without derived children", () => {
    expect(hasRalphLayoutGroupMismatch(createFlow([]))).toBe(false);
    expect(
      hasRalphLayoutGroupMismatch(
        createFlow([
          {
            id: "group",
            type: "GROUP",
            title: "Group",
            childBlockIds: [],
            position: { x: 0, y: 0 },
            size: { width: 500, height: 500 },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("detects stale child id lists", () => {
    expect(
      hasRalphLayoutGroupMismatch(
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
            id: "child",
            type: "START",
            title: "Child",
            parentGroupId: "group",
            position: { x: 50, y: 50 },
          },
        ]),
      ),
    ).toBe(true);
  });

  it("detects unpositioned or out-of-bounds children", () => {
    const group = {
      id: "group",
      type: "GROUP" as const,
      title: "Group",
      childBlockIds: ["child"],
      position: { x: 0, y: 0 },
      size: { width: 500, height: 500 },
    };

    expect(
      hasRalphLayoutGroupMismatch(
        createFlow([
          group,
          {
            id: "child",
            type: "START",
            title: "Child",
            parentGroupId: "group",
          },
        ]),
      ),
    ).toBe(true);

    expect(
      hasRalphLayoutGroupMismatch(
        createFlow([
          group,
          {
            id: "child",
            type: "START",
            title: "Child",
            parentGroupId: "group",
            position: { x: 1000, y: 1000 },
          },
        ]),
      ),
    ).toBe(true);
  });

  it("accepts positioned children contained by their group", () => {
    expect(
      hasRalphLayoutGroupMismatch(
        createFlow([
          {
            id: "group",
            type: "GROUP",
            title: "Group",
            childBlockIds: ["child"],
            position: { x: 0, y: 0 },
            size: { width: 500, height: 500 },
          },
          {
            id: "child",
            type: "START",
            title: "Child",
            parentGroupId: "group",
            position: { x: 50, y: 50 },
          },
        ]),
      ),
    ).toBe(false);
  });
});
