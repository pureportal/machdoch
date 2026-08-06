import { parseRalphValidatorJsonResult } from "./parse-ralph-validator-json-result.helper.ts";

describe("parseRalphValidatorJsonResult", () => {
  const validResult = {
    decision: "DONE",
    confidence: "high",
    summary: "Verified.",
    evidence: ["Tests passed."],
    remainingWork: [],
  } as const;

  it("accepts the exact validator protocol", () => {
    expect(parseRalphValidatorJsonResult(validResult)).toEqual(validResult);
  });

  it.each([
    { ...validResult, decision: "done" },
    { ...validResult, decision: " DONE " },
    { ...validResult, decision: 'DONE because the response said "complete"' },
    { ...validResult, authority: "DONE" },
    { ...validResult, evidence: ["valid", 1] },
    { ...validResult, remainingWork: "none" },
    { decision: "DONE", summary: "Missing fields." },
    null,
  ])("rejects malformed or prose-derived verdict state %#", (value) => {
    expect(parseRalphValidatorJsonResult(value)).toBeUndefined();
  });
});
