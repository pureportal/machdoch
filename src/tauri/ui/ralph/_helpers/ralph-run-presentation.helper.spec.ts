import { describe, expect, it } from "vitest";
import { getRunStatusPresentation } from "./ralph-run-presentation.helper";

describe("RALPH run outcome presentation", () => {
  it.each([
    ["succeeded", "Verified"],
    ["no-op", "Verified no-op"],
    ["deferred", "Deferred"],
    ["blocked", "Blocked"],
    ["stalled", "Stalled"],
    ["budget-exhausted", "Budget exhausted"],
    ["verification-inconclusive", "Unverified"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ] as const)("presents semantic outcome %s as %s", (outcome, label) => {
    expect(getRunStatusPresentation("completed", outcome).label).toBe(label);
  });

  it("does not show an inconclusive completed lifecycle as success", () => {
    const presentation = getRunStatusPresentation(
      "completed",
      "verification-inconclusive",
    );

    expect(presentation.label).toBe("Unverified");
    expect(presentation.spin).toBeUndefined();
  });

  it("does not show lifecycle completion without an outcome as success", () => {
    expect(getRunStatusPresentation("completed").label).toBe("Unverified");
  });
});
