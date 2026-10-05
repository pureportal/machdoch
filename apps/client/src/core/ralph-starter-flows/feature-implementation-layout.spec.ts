import { describe, expect, it } from "vitest";
import { normalizeRalphFlowLayout } from "../ralph-layout.js";
import {
  getRalphStarterFlow,
  STARTER_RALPH_FLOWS,
} from "../ralph-starter-flows.js";
import {
  doRalphLayoutBoundsContain,
  doRalphLayoutBoundsOverlap,
  getRalphLayoutNodeBoundsAtPosition,
} from "../_helpers/ralph-layout-node-bounds.helper.js";

describe("feature template phases", () => {
  it.each(STARTER_RALPH_FLOWS)(
    "groups $id without hiding or rerouting work",
    ({ flow }) => {
      const groups = flow.blocks.filter((block) => block.type === "GROUP");
      const children = flow.blocks.filter((block) => block.type !== "GROUP");
      expect(groups).toHaveLength(4);
      expect(
        groups.every(
          (group) =>
            group.collapsed && group.executionBoundary?.mode === "none",
        ),
      ).toBe(true);
      const memberIds = groups.flatMap((group) => group.childBlockIds);
      expect(memberIds.length).toBe(children.length);
      expect(new Set(memberIds)).toEqual(
        new Set(children.map((block) => block.id)),
      );
      for (const child of children) {
        expect(
          groups.find((group) => group.id === child.parentGroupId)
            ?.childBlockIds,
        ).toContain(child.id);
      }
      expect(
        flow.edges.every(
          (edge) =>
            memberIds.includes(edge.from) && memberIds.includes(edge.to),
        ),
      ).toBe(true);
      for (const group of groups) {
        const groupedChildren = children.filter(
          (child) => child.parentGroupId === group.id,
        );
        for (const child of groupedChildren) {
          expect(
            doRalphLayoutBoundsContain(
              getRalphLayoutNodeBoundsAtPosition(group, group.position!),
              getRalphLayoutNodeBoundsAtPosition(child, child.position!),
            ),
          ).toBe(true);
        }
      }
    },
  );

  it("keeps every executable node visible inside one nonoverlapping phase", () => {
    const flow = getRalphStarterFlow("full-feature-implementation")!.flow;
    const groups = flow.blocks.filter((block) => block.type === "GROUP");
    expect(groups.map((group) => group.title)).toEqual([
      "Plan",
      "Implement",
      "Verify",
      "Record outcome",
    ]);
    const members = groups.flatMap((group) => group.childBlockIds);
    const children = flow.blocks.filter((block) => block.type !== "GROUP");
    expect(new Set(members).size).toBe(children.length);
    expect(members.length).toBe(children.length);
    for (const group of groups) {
      expect(group.collapsed).toBe(true);
      expect(group.executionBoundary?.mode).toBe("none");
      const bounds = getRalphLayoutNodeBoundsAtPosition(group, group.position!);
      for (const child of children.filter(
        (block) => block.parentGroupId === group.id,
      )) {
        expect(group.childBlockIds).toContain(child.id);
        expect(
          doRalphLayoutBoundsContain(
            bounds,
            getRalphLayoutNodeBoundsAtPosition(child, child.position!),
          ),
        ).toBe(true);
      }
    }
    for (let index = 0; index < children.length; index++) {
      const bounds = getRalphLayoutNodeBoundsAtPosition(
        children[index]!,
        children[index]!.position!,
        36,
      );
      for (const other of children.slice(index + 1)) {
        expect(
          doRalphLayoutBoundsOverlap(
            bounds,
            getRalphLayoutNodeBoundsAtPosition(other, other.position!, 36),
          ),
        ).toBe(false);
      }
    }
    expect(normalizeRalphFlowLayout(flow)).toBe(flow);
    const executableIds = new Set(children.map((block) => block.id));
    expect(
      flow.edges.every(
        (edge) => executableIds.has(edge.from) && executableIds.has(edge.to),
      ),
    ).toBe(true);
  });
});
