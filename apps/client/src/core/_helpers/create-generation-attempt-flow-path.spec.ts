import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGenerationAttemptFlowPath } from "./create-generation-attempt-flow-path.helper.js";

describe("createGenerationAttemptFlowPath", () => {
  it("inserts the round before an existing extension", () => {
    expect(createGenerationAttemptFlowPath(join("out", "flow.json"), 3)).toBe(
      join("out", "flow-round-3.json"),
    );
  });

  it("uses the existing extension for non-json paths", () => {
    expect(createGenerationAttemptFlowPath(join("out", "flow.tmp"), 2)).toBe(
      join("out", "flow-round-2.tmp"),
    );
  });

  it("falls back to the Ralph flow extension when no extension is present", () => {
    expect(createGenerationAttemptFlowPath(join("out", "flow"), 1)).toBe(
      join("out", "flow-round-1.json"),
    );
  });
});
