import { describe, expect, it } from "vitest";
import { consumeRalphSupervisedRunId } from "./consume-ralph-supervised-run-id.helper.js";

describe("supervised RALPH run identity", () => {
  it("accepts an owned desktop identifier and leaves standalone runs unpinned", () => {
    expect(consumeRalphSupervisedRunId({})).toBeUndefined();
    expect(
      consumeRalphSupervisedRunId({
        MACHDOCH_RALPH_RUN_ID: "desktop-123-456-0",
      }),
    ).toBe("desktop-123-456-0");
  });
  it("rejects invalid identifiers before creating run artifacts", () => {
    for (const id of ["", "../other", "desktop-123/456", "another-run"]) {
      expect(() =>
        consumeRalphSupervisedRunId({ MACHDOCH_RALPH_RUN_ID: id }),
      ).toThrow("Invalid supervised RALPH run identifier");
    }
  });
  it("consumes the launch identity before a run can spawn another CLI", () => {
    const environment = { MACHDOCH_RALPH_RUN_ID: "desktop-123-456-0" };
    expect(consumeRalphSupervisedRunId(environment)).toBe("desktop-123-456-0");
    expect(consumeRalphSupervisedRunId(environment)).toBeUndefined();
    expect(environment.MACHDOCH_RALPH_RUN_ID).toBeUndefined();
  });
});
