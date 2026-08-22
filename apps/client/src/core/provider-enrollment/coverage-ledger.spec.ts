import { describe, expect, it } from "vitest";
import { summarizeEnrollmentCoverage } from "./coverage-ledger.js";
import type { EnrollmentCoverageEntry } from "./types.js";

const entry = (
  id: string,
  covered: boolean,
  route: EnrollmentCoverageEntry["route"],
): EnrollmentCoverageEntry => ({
  entityId: id,
  entityKind: "mcp-server",
  provider: "openai",
  digest: id,
  route,
  fidelity: covered ? "exact" : "degraded",
  refreshState: covered ? "request-current" : "degraded",
  covered,
  evidence: [],
});

describe("MCP enrollment coverage ledger", () => {
  it("derives completeness from entity rows instead of provider flags", () => {
    const summary = summarizeEnrollmentCoverage([
      entry("a", true, "application-mcp"),
      entry("b", false, "uncovered"),
    ]);
    expect(summary).toMatchObject({
      total: 2,
      covered: 1,
      uncovered: 1,
      complete: false,
      uncoveredEntityIds: ["b"],
      routes: { "application-mcp": 1, uncovered: 1 },
    });
  });
});
