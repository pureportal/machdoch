import { appendRalphInterviewAnswers } from "./append-ralph-interview-answers.helper.ts";

describe("appendRalphInterviewAnswers", () => {
  it("preserves turn state and appends answers by field id", () => {
    expect(
      appendRalphInterviewAnswers(
        {
          turn: 2,
          transcript: [
            { fieldId: "existing", question: "Existing?", answer: true },
          ],
        },
        {
          fields: [
            { id: "name", label: "Name?", type: "text" },
            { id: "count", label: "Count?", type: "number" },
          ],
        },
        { name: "Acme", count: 3 },
      ),
    ).toEqual({
      turn: 2,
      transcript: [
        { fieldId: "existing", question: "Existing?", answer: true },
        { fieldId: "name", question: "Name?", answer: "Acme" },
        { fieldId: "count", question: "Count?", answer: 3 },
      ],
    });
  });

  it("records null for missing and undefined answers", () => {
    expect(
      appendRalphInterviewAnswers(
        { turn: 0, transcript: [] },
        {
          fields: [
            { id: "missing", label: "Missing?", type: "text" },
            { id: "undefined", label: "Undefined?", type: "text" },
          ],
        },
        { undefined: undefined },
      ),
    ).toEqual({
      turn: 0,
      transcript: [
        { fieldId: "missing", question: "Missing?", answer: null },
        { fieldId: "undefined", question: "Undefined?", answer: null },
      ],
    });
  });
});
