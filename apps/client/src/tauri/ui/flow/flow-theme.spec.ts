import { describe, expect, it } from "vitest";

import {
  FLOW_PORT_PRESENTATIONS,
  createFlowCanvasEdge,
  getFlowEdgeStyle,
} from "./flow-theme";

describe("flow theme", () => {
  it("uses the matching port color for an edge", () => {
    expect(getFlowEdgeStyle("fuchsia")).toMatchObject({
      stroke: FLOW_PORT_PRESENTATIONS.fuchsia.color,
      strokeWidth: 1.65,
      opacity: 1,
    });
  });

  it("makes emphasized branches easier to trace", () => {
    expect(
      getFlowEdgeStyle("rose", { emphasis: "strong", muted: true }),
    ).toMatchObject({
      stroke: FLOW_PORT_PRESENTATIONS.rose.color,
      strokeWidth: 2.75,
      opacity: 0.42,
    });
  });

  it("keeps every port tone visually distinct", () => {
    const colors = Object.values(FLOW_PORT_PRESENTATIONS).map(
      (presentation) => presentation.color,
    );

    expect(new Set(colors).size).toBe(colors.length);
  });

  it("projects a canonical connected edge", () => {
    expect(
      createFlowCanvasEdge({
        id: "prompt-to-image",
        source: "brief",
        sourceHandle: "prompt",
        target: "generate",
        targetHandle: "prompt",
        tone: "sky",
        selected: true,
      }),
    ).toMatchObject({
      id: "prompt-to-image",
      type: "flow",
      source: "brief",
      sourceHandle: "prompt",
      target: "generate",
      targetHandle: "prompt",
      selected: true,
      style: {
        stroke: FLOW_PORT_PRESENTATIONS.sky.color,
      },
    });
  });
});
