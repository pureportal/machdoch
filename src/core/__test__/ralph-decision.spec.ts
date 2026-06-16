import { parseRalphDecision } from "../ralph.js";
import { createExecutionResult } from "./ralph-test-helpers.js";
describe("parseRalphDecision", () => {
  it("reads only the final marker line", () => {
    expect(
      parseRalphDecision(
        createExecutionResult({
          response: {
            markdown: "Earlier RALPH_DECISION: RETRY\n\nRALPH_DECISION: DONE",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBe("DONE");
  });

  it("ignores marker text that is not the final line", () => {
    expect(
      parseRalphDecision(
        createExecutionResult({
          response: {
            markdown: "RALPH_DECISION: DONE\n\nMore text.",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBeUndefined();
  });
});

