import { describe, expect, it } from "vitest";
import type { RalphFlow } from "../ralph.js";
import { layoutRalphStarterPhases } from "./starter-phase-layout.js";

const flow: RalphFlow = {
  schemaVersion: 1,
  id: "fixture",
  name: "Fixture",
  settings: { autonomy: true },
  blocks: [
    { id: "start", type: "START", title: "Start" },
    { id: "work", type: "PROMPT", title: "Work", prompt: "Implement the task" },
    { id: "done", type: "END", title: "Done", status: "success" },
  ],
  edges: [
    { id: "start-work", from: "start", fromOutput: "NEXT", to: "work" },
    { id: "work-done", from: "work", fromOutput: "SUCCESS", to: "done" },
  ],
};

describe("starter phase layout", () => {
  it("preserves executable content, settings, and routes without mutating its source", () => {
    const before = structuredClone(flow);
    const grouped = layoutRalphStarterPhases(flow, [
      { id: "phase", title: "Work", childBlockIds: ["start", "work", "done"] },
    ]);
    expect(flow).toEqual(before);
    expect(grouped.settings).toBe(flow.settings);
    expect(grouped.edges).toBe(flow.edges);
    for (const block of grouped.blocks.filter(
      (block) => block.type !== "GROUP",
    )) {
      const { parentGroupId, position, size, ...execution } = block;
      expect(parentGroupId).toBe("phase");
      expect(position).toBeDefined();
      expect(size).toBeDefined();
      expect(execution).toEqual(
        flow.blocks.find((original) => original.id === block.id),
      );
    }
  });

  it("rejects incomplete, missing, and repeated memberships", () => {
    for (const childBlockIds of [
      ["start"],
      ["missing"],
      ["start", "start", "work", "done"],
    ]) {
      expect(() =>
        layoutRalphStarterPhases(flow, [
          { id: "phase", title: "Work", childBlockIds },
        ]),
      ).toThrow();
    }
  });
});
