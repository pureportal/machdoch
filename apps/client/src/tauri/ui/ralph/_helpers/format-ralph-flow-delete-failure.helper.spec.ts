import { formatRalphFlowDeleteFailure } from "./format-ralph-flow-delete-failure.helper.js";

describe("formatRalphFlowDeleteFailure", () => {
  it("turns a concurrency conflict into a recovery instruction", () => {
    expect(
      formatRalphFlowDeleteFailure(
        "Autonomous loop",
        new Error(
          "The Ralph CLI command failed. Ralph flow CAS conflict: fingerprints differ.",
        ),
      ),
    ).toBe(
      'Ralph flow "Autonomous loop" changed. Refresh the flow list, then delete it again.',
    );
  });

  it("retains an actionable persistence error", () => {
    expect(
      formatRalphFlowDeleteFailure(
        "Autonomous loop",
        new Error("Access to the flow file was denied."),
      ),
    ).toBe(
      'Could not delete Ralph flow "Autonomous loop": Access to the flow file was denied.',
    );
  });
});
