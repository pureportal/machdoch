import { normalizeRalphFlowLayout, type RalphFlow } from "../ralph.js";
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
});


