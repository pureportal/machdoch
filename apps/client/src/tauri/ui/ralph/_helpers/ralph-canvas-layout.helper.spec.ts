import { describe, expect, it } from "vitest";

import { FLOW_PORT_PRESENTATIONS } from "../../flow/flow-theme";
import { createBlankFlow } from "./create-blank-ralph-flow.helper";
import { flowToEdges, flowToNodes } from "./ralph-canvas-layout.helper";

describe("Ralph canvas projection", () => {
  it("preserves moved positions and selected node state", () => {
    const flow = createBlankFlow("canvas-projection");
    const movedFlow = {
      ...flow,
      blocks: flow.blocks.map((block) =>
        block.id === "start"
          ? { ...block, position: { x: 314, y: 159 } }
          : block,
      ),
    };

    const startNode = flowToNodes(movedFlow, [], "start", null).find(
      (node) => node.id === "start",
    );

    expect(startNode).toMatchObject({
      position: { x: 314, y: 159 },
      data: { selected: true },
    });
  });

  it("projects connected branches through the canonical edge type", () => {
    const flow = createBlankFlow("edge-projection");
    const [edge] = flowToEdges(flow, null, "start");

    expect(edge).toMatchObject({
      id: "start-success-end",
      type: "flow",
      source: "start",
      sourceHandle: "SUCCESS",
      target: "end",
      selected: false,
      style: {
        stroke: FLOW_PORT_PRESENTATIONS.emerald.color,
        strokeWidth: 2.1,
      },
    });
  });

  it("emphasizes a selected connection", () => {
    const flow = createBlankFlow("selected-edge");
    const [edge] = flowToEdges(flow, "start-success-end", null);

    expect(edge).toMatchObject({
      selected: true,
      style: { strokeWidth: 2.75 },
    });
  });
});
