import {
  normalizeRalphWorkItemState,
  transitionRalphWorkItemState,
} from "./transition-ralph-work-item-state.helper.ts";

describe("transitionRalphWorkItemState", () => {
  it("normalizes legacy state names and allows the canonical lifecycle", () => {
    expect(normalizeRalphWorkItemState("in_progress")).toBe("implementing");
    expect(transitionRalphWorkItemState("pending", "implementing")).toEqual({
      from: "planned",
      to: "implementing",
      changed: true,
    });
    expect(transitionRalphWorkItemState("implementing", "verifying")).toEqual({
      from: "implementing",
      to: "verifying",
      changed: true,
    });
    expect(transitionRalphWorkItemState("verifying", "done")).toEqual({
      from: "verifying",
      to: "completed",
      changed: true,
    });
  });

  it("allows idempotent updates and rejects skipped or terminal transitions", () => {
    expect(transitionRalphWorkItemState("repairing", "repairing").changed).toBe(
      false,
    );
    expect(() => transitionRalphWorkItemState("planned", "completed")).toThrow(
      "Invalid work-item state transition planned -> completed.",
    );
    expect(() => transitionRalphWorkItemState("completed", "repairing")).toThrow(
      "Invalid work-item state transition completed -> repairing.",
    );
  });
});
