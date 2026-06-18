import { normalizeRalphFlowLayout } from "../ralph-layout.js";
import type { RalphFlow } from "../ralph.js";
describe("normalizeRalphFlowLayout", () => {
  it("separates overlapping generated branch nodes into readable columns", () => {
    const flow: RalphFlow = {
      schemaVersion: 1,
      id: "copy-flow",
      name: "Copy Flow",
      blocks: [
        {
          id: "start",
          type: "START",
          title: "Start",
          position: { x: 0, y: 0 },
        },
        {
          id: "copy",
          type: "UTILITY",
          title: "Wait for file and copy",
          utility: { type: "RUN_COMMAND", command: "copy" },
          position: { x: 80, y: 0 },
        },
        {
          id: "notify",
          type: "UTILITY",
          title: "Notify copy success",
          utility: { type: "NOTIFY", message: "Copied" },
          position: { x: 160, y: 0 },
        },
        {
          id: "copy-failed",
          type: "END",
          title: "Copy failed",
          status: "failed",
          position: { x: 170, y: 20 },
        },
        {
          id: "copy-succeeded",
          type: "END",
          title: "Copy succeeded",
          status: "success",
          position: { x: 210, y: 10 },
        },
      ],
      edges: [
        { id: "start-copy", from: "start", fromOutput: "SUCCESS", to: "copy" },
        { id: "copy-notify", from: "copy", fromOutput: "SUCCESS", to: "notify" },
        {
          id: "copy-failed",
          from: "copy",
          fromOutput: "ERROR",
          to: "copy-failed",
        },
        {
          id: "notify-end",
          from: "notify",
          fromOutput: "SUCCESS",
          to: "copy-succeeded",
        },
      ],
    };

    const arranged = normalizeRalphFlowLayout(flow);
    const positionById = new Map(
      arranged.blocks.map((block) => [block.id, block.position] as const),
    );

    expect(positionById.get("start")).toEqual({ x: 0, y: 0 });
    expect(positionById.get("copy")?.x).toBeGreaterThan(
      positionById.get("start")?.x ?? 0,
    );
    expect(positionById.get("notify")?.x).toBeGreaterThan(
      positionById.get("copy")?.x ?? 0,
    );
    expect(positionById.get("copy-succeeded")?.x).toBeGreaterThan(
      positionById.get("notify")?.x ?? 0,
    );
    expect(
      Math.abs(
        (positionById.get("notify")?.y ?? 0) -
          (positionById.get("copy-failed")?.y ?? 0),
      ),
    ).toBeGreaterThanOrEqual(190);
  });

  it("wraps generated groups around parentGroupId children", () => {
    const flow: RalphFlow = {
      schemaVersion: 1,
      id: "grouped-flow",
      name: "Grouped Flow",
      blocks: [
        {
          id: "start",
          type: "START",
          title: "Start",
          position: { x: 0, y: 0 },
        },
        {
          id: "loop-group",
          type: "GROUP",
          title: "Refactoring Loop",
          childBlockIds: [],
          position: { x: 3740, y: -95 },
          size: { width: 1980, height: 760 },
        },
        {
          id: "capture",
          type: "UTILITY",
          title: "Capture state",
          parentGroupId: "loop-group",
          utility: { type: "GIT_STATUS" },
          position: { x: 340, y: 0 },
        },
        {
          id: "review",
          type: "PROMPT",
          title: "Review",
          parentGroupId: "loop-group",
          prompt: "Review the code.",
          position: { x: 680, y: 0 },
        },
        {
          id: "validate",
          type: "VALIDATOR",
          title: "Validate",
          parentGroupId: "loop-group",
          prompt:
            "Validate the change. End with RALPH_DECISION: DONE, CONTINUE, RETRY, or ERROR.",
          position: { x: 1020, y: 0 },
        },
        {
          id: "success",
          type: "END",
          title: "Success",
          status: "success",
          position: { x: 1360, y: 0 },
        },
      ],
      edges: [
        {
          id: "start-capture",
          from: "start",
          fromOutput: "SUCCESS",
          to: "capture",
        },
        {
          id: "capture-review",
          from: "capture",
          fromOutput: "SUCCESS",
          to: "review",
        },
        {
          id: "review-validate",
          from: "review",
          fromOutput: "SUCCESS",
          to: "validate",
        },
        {
          id: "validate-success",
          from: "validate",
          fromOutput: "DONE",
          to: "success",
        },
        {
          id: "validate-retry",
          from: "validate",
          fromOutput: "RETRY",
          to: "review",
        },
      ],
    };

    const arranged = normalizeRalphFlowLayout(flow);
    const blockById = new Map(arranged.blocks.map((block) => [block.id, block]));
    const group = blockById.get("loop-group");
    const childBlocks = ["capture", "review", "validate"].map((blockId) =>
      blockById.get(blockId),
    );

    expect(group).toMatchObject({
      type: "GROUP",
      childBlockIds: ["capture", "review", "validate"],
    });
    expect(group?.position?.x).toBeLessThan(1000);

    for (const childBlock of childBlocks) {
      expect(childBlock?.position).toBeDefined();
      expect(childBlock?.position?.x).toBeGreaterThanOrEqual(
        group?.position?.x ?? Number.POSITIVE_INFINITY,
      );
      expect(childBlock?.position?.y).toBeGreaterThanOrEqual(
        group?.position?.y ?? Number.POSITIVE_INFINITY,
      );
      expect(childBlock?.position?.x).toBeLessThan(
        (group?.position?.x ?? 0) + (group?.size?.width ?? 0),
      );
      expect(childBlock?.position?.y).toBeLessThan(
        (group?.position?.y ?? 0) + (group?.size?.height ?? 0),
      );
    }
  });
});


