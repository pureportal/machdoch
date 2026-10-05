import { describe, expect, it } from "vitest";

import { FLOW_PORT_PRESENTATIONS } from "@machdoch/media-studio/tauri/ui/flow/flow-theme.js";
import { createBlankFlow } from "./create-blank-ralph-flow.helper";
import {
  flowToEdges,
  flowToNodes,
  getCanvasBlockBounds,
  doCanvasBoundsOverlap,
} from "./ralph-canvas-layout.helper";
import type { RalphFlowBlock } from "../../../../core/ralph.js";

describe("Ralph canvas projection", () => {
  it("compacts a phase overview without changing its expanded geometry", () => {
    const groups = Array.from({ length: 4 }, (_, index) => ({
      id: `phase-${index}`,
      title: `Phase ${index}`,
      type: "GROUP" as const,
      collapsed: true,
      position: { x: index * 5000, y: 100 },
      size: { width: 2400, height: 1800 },
      childBlockIds: [`child-${index}`],
    }));
    const children = groups.map((group, index) => ({
      id: `child-${index}`,
      title: `Child ${index}`,
      type: "END" as const,
      parentGroupId: group.id,
      position: { x: group.position.x + 100, y: 200 },
    }));
    const flow = {
      ...createBlankFlow("large-phases"),
      blocks: [...groups, ...children] as RalphFlowBlock[],
      edges: [],
    };
    const original = JSON.stringify(flow);
    const visible = flowToNodes(flow, [], null, null).filter(
      (node) => !node.hidden,
    );
    expect(visible).toHaveLength(4);
    expect(visible.every((node) => node.draggable === false)).toBe(true);
    expect(visible.map((node) => node.style)).toEqual(
      Array.from({ length: 4 }, () => ({ width: 320, height: 72 })),
    );
    expect(Math.max(...visible.map((node) => node.position.x + 320))).toBe(820);
    expect(Math.max(...visible.map((node) => node.position.y + 72))).toBe(392);
    expect(JSON.stringify(flow)).toBe(original);
    const expanded = flowToNodes(
      {
        ...flow,
        blocks: flow.blocks.map((block) =>
          block.type === "GROUP" ? { ...block, collapsed: false } : block,
        ),
      },
      [],
      null,
      null,
    );
    for (const group of groups) {
      expect(expanded.find((node) => node.id === group.id)).toMatchObject({
        position: group.position,
        style: group.size,
      });
    }
    expect(expanded.filter((node) => !node.hidden)).toHaveLength(8);
  });

  it("keeps deduplicated phase connections visible through nested collapsed groups", () => {
    const flow = {
      ...createBlankFlow("collapsed-phases"),
      blocks: [
        { id: "plan", title: "Plan", type: "GROUP", collapsed: true },
        {
          id: "nested",
          title: "Nested",
          type: "GROUP",
          collapsed: true,
          parentGroupId: "plan",
        },
        { id: "start", title: "Start", type: "START", parentGroupId: "nested" },
        {
          id: "check",
          title: "Check",
          type: "UTILITY",
          utility: { type: "RUN_CHECK" },
          parentGroupId: "plan",
        },
        { id: "verify", title: "Verify", type: "GROUP", collapsed: true },
        { id: "end", title: "End", type: "END", parentGroupId: "verify" },
      ] as RalphFlowBlock[],
      edges: [
        { id: "internal", from: "start", fromOutput: "SUCCESS", to: "check" },
        { id: "forward", from: "start", fromOutput: "SUCCESS", to: "end" },
        { id: "duplicate", from: "check", fromOutput: "FAILED", to: "end" },
        { id: "repair", from: "end", fromOutput: "ERROR", to: "start" },
      ],
    };
    const before = JSON.stringify(flow);
    const visible = flowToEdges(flow, null, null).filter(
      (edge) => !edge.hidden,
    );
    expect(visible).toHaveLength(2);
    expect(visible).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "plan",
          target: "verify",
          sourceHandle: "group-output",
          data: { output: "" },
        }),
        expect.objectContaining({ source: "verify", target: "plan" }),
      ]),
    );
    const nodes = flowToNodes(flow, [], null, null);
    const activeNodes = flowToNodes(flow, [], null, "start").filter(
      (node) => !node.hidden && node.data.active,
    );
    expect(activeNodes.map((node) => node.id)).toEqual(["plan"]);
    expect(
      visible.every(
        (edge) =>
          edge.zIndex! < nodes.find((node) => node.id === edge.source)!.zIndex!,
      ),
    ).toBe(true);
    expect(nodes.find((node) => node.id === "plan")?.data).toMatchObject({
      outputs: ["group-output"],
      collapsedGroupInput: true,
    });
    expect(nodes.find((node) => node.id === "nested")?.hidden).toBe(true);
    expect(JSON.stringify(flow)).toBe(before);
    const expanded = {
      ...flow,
      blocks: flow.blocks.map((block) =>
        block.type === "GROUP" ? { ...block, collapsed: false } : block,
      ),
    };
    expect(
      flowToEdges(expanded, null, null).filter((edge) => !edge.hidden),
    ).toHaveLength(4);
    expect(
      flowToNodes(expanded, [], null, "start")
        .filter((node) => !node.hidden && node.data.active)
        .map((node) => node.id),
    ).toEqual(["start"]);
  });

  it("preserves distinct outputs from an expanded node into a collapsed phase", () => {
    const flow = {
      ...createBlankFlow("mixed-phases"),
      blocks: [
        { id: "start", title: "Start", type: "START" },
        { id: "group", title: "Phase", type: "GROUP", collapsed: true },
        { id: "end", title: "End", type: "END", parentGroupId: "group" },
      ] as RalphFlowBlock[],
      edges: [
        { id: "success", from: "start", fromOutput: "SUCCESS", to: "end" },
        { id: "error", from: "start", fromOutput: "ERROR", to: "end" },
      ],
    };
    const visible = flowToEdges(flow, null, null).filter(
      (edge) => !edge.hidden,
    );
    expect(visible).toHaveLength(2);
    expect(visible.map((edge) => edge.sourceHandle)).toEqual([
      "SUCCESS",
      "ERROR",
    ]);
    expect(visible.every((edge) => edge.target === "group")).toBe(true);
  });

  it("separates default rows for nodes with multiple outputs", () => {
    const blocks: RalphFlowBlock[] = [
      { id: "start", type: "START", title: "Start" },
      {
        id: "read",
        type: "UTILITY",
        title: "Read JSON",
        utility: { type: "READ_JSON", path: "references.json" },
      },
      {
        id: "write",
        type: "UTILITY",
        title: "Write",
        utility: {
          type: "WRITE_FILE",
          path: "output.txt",
          content: "{{lastResult}}",
        },
      },
      { id: "end", type: "END", title: "End" },
    ];
    const bounds = blocks.map(getCanvasBlockBounds);
    for (let index = 0; index < bounds.length; index += 1) {
      for (const other of bounds.slice(index + 1)) {
        expect(doCanvasBoundsOverlap(bounds[index]!, other)).toBe(false);
      }
    }
  });
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
