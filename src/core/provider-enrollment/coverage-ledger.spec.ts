import { describe, expect, it } from "vitest";
import { summarizeEnrollmentCoverage } from "./coverage-ledger.js";
import type { EnrollmentCoverageEntry } from "./types.js";

const entry = (
  id: string,
  covered: boolean,
  route: EnrollmentCoverageEntry["route"],
): EnrollmentCoverageEntry => ({
  entityId: id,
  entityKind: "instruction",
  provider: "openai",
  digest: id,
  route,
  fidelity: covered ? "exact" : "degraded",
  refreshState: covered ? "request-current" : "degraded",
  covered,
  evidence: [],
});

describe("enrollment coverage ledger", () => {
  it("derives completeness from entity rows instead of provider flags", () => {
    const summary = summarizeEnrollmentCoverage([
      entry("a", true, "api-request"),
      entry("b", false, "uncovered"),
    ]);
    expect(summary).toMatchObject({
      total: 2,
      covered: 1,
      uncovered: 1,
      complete: false,
      uncoveredEntityIds: ["b"],
      routes: { "api-request": 1, uncovered: 1 },
    });
  });
});
