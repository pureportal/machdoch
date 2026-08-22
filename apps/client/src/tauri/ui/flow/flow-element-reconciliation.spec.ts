import { describe, expect, it } from "vitest";

import { reconcileFlowElements } from "./flow-element-reconciliation";

interface Element {
  id: string;
  value: string;
  position: { x: number; y: number };
}

const reconcile = (
  current: Element[],
  projected: readonly Element[],
): Element[] =>
  reconcileFlowElements({
    current,
    projected,
    equals: (left, right) =>
      left.value === right.value &&
      left.position.x === right.position.x &&
      left.position.y === right.position.y,
    merge: (left, right) => ({ ...right, position: left.position }),
  });

describe("reconcileFlowElements", () => {
  it("keeps stable element references when a runtime refresh projects no display change", () => {
    const current = [
      { id: "source", value: "Completed", position: { x: 10, y: 20 } },
      { id: "output", value: "Pending", position: { x: 40, y: 20 } },
    ];

    const next = reconcile(current, current.map((element) => ({ ...element })));

    expect(next).toBe(current);
    expect(next).toEqual(current);
    expect(next[0]).toBe(current[0]);
    expect(next[1]).toBe(current[1]);
  });

  it("updates only the changed execution node while retaining dragged positions", () => {
    const current = [
      { id: "source", value: "Completed", position: { x: 10, y: 20 } },
      { id: "output", value: "Pending", position: { x: 96, y: 20 } },
    ];
    const next = reconcile(current, [
      { id: "source", value: "Completed", position: { x: 10, y: 20 } },
      { id: "output", value: "Running", position: { x: 40, y: 20 } },
    ]);

    expect(next[0]).toBe(current[0]);
    expect(next[1]).not.toBe(current[1]);
    expect(next[1]).toMatchObject({
      value: "Running",
      position: { x: 96, y: 20 },
    });
  });

  it("returns elements in projected topology order", () => {
    const current = [
      { id: "source", value: "Completed", position: { x: 10, y: 20 } },
      { id: "output", value: "Pending", position: { x: 40, y: 20 } },
    ];
    const next = reconcile(current, [current[1]!, current[0]!]);

    expect(next.map((element) => element.id)).toEqual(["output", "source"]);
  });
});
