import {
  getDefaultRalphInterviewOutputVariableName,
  getRalphInterviewOutputVariableName,
} from "./get-ralph-interview-output-variable-name.helper.ts";

describe("getRalphInterviewOutputVariableName", () => {
  it("uses a valid configured output variable name", () => {
    expect(
      getRalphInterviewOutputVariableName({
        id: "interview-1",
        outputVariableName: "  customer_requirements  ",
      }),
    ).toBe("customer_requirements");
  });

  it("falls back to a sanitized block id for invalid, blank, and missing names", () => {
    expect(getDefaultRalphInterviewOutputVariableName({ id: "QA Interview!" })).toBe(
      "QA_Interview__interview",
    );
    expect(
      getRalphInterviewOutputVariableName({
        id: "qa.interview",
        outputVariableName: "123 invalid",
      }),
    ).toBe("qa_interview_interview");
    expect(
      getRalphInterviewOutputVariableName({
        id: "qa interview",
        outputVariableName: "   ",
      }),
    ).toBe("qa_interview_interview");
    expect(getRalphInterviewOutputVariableName({ id: "" })).toBe("_interview");
  });
});
