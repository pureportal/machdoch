import {
  parseRalphWorkItemState,
  transitionRalphWorkItemState,
} from "./transition-ralph-work-item-state.helper.ts";

describe("transitionRalphWorkItemState", () => {
  it("allows the canonical lifecycle", () => {
    expect(parseRalphWorkItemState("implementing")).toBe("implementing");
    expect(transitionRalphWorkItemState("planned", "implementing")).toEqual({
      from: "planned",
      to: "implementing",
      changed: true,
    });
    expect(transitionRalphWorkItemState("implementing", "verifying")).toEqual({
      from: "implementing",
      to: "verifying",
      changed: true,
    });
    expect(transitionRalphWorkItemState("verifying", "completed")).toEqual({
      from: "verifying",
      to: "completed",
      changed: true,
    });
  });

  it("allows idempotent updates and rejects aliases, skipped, or terminal transitions", () => {
    expect(transitionRalphWorkItemState("repairing", "repairing").changed).toBe(
      false,
    );
    expect(parseRalphWorkItemState("in_progress")).toBeUndefined();
    expect(parseRalphWorkItemState(" IMPLEMENTING ")).toBeUndefined();
    expect(parseRalphWorkItemState("IMPLEMENTING")).toBeUndefined();
    expect(() =>
      transitionRalphWorkItemState(undefined, "implementing"),
    ).toThrow("Unsupported current work-item state");
    expect(() =>
      transitionRalphWorkItemState("pending", "implementing"),
    ).toThrow("Unsupported current work-item state");
    expect(() => transitionRalphWorkItemState("planned", "completed")).toThrow(
      "Invalid work-item state transition planned -> completed.",
    );
    expect(() =>
      transitionRalphWorkItemState("completed", "repairing"),
    ).toThrow("Invalid work-item state transition completed -> repairing.");
  });
});
