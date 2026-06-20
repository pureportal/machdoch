import { createRalphInterviewTranscriptMarkdown } from "./create-ralph-interview-transcript-markdown.helper.ts";

describe("createRalphInterviewTranscriptMarkdown", () => {
  it("renders an empty transcript message", () => {
    expect(createRalphInterviewTranscriptMarkdown({ transcript: [] })).toBe(
      "No interview answers were collected.",
    );
  });

  it("renders collected answers and marks nullish answers as skipped", () => {
    expect(
      createRalphInterviewTranscriptMarkdown({
        transcript: [
          { fieldId: "name", question: "Name?", answer: "Acme" },
          { fieldId: "tags", question: "Tags?", answer: ["alpha", "beta"] },
          { fieldId: "skip", question: "Optional?", answer: null },
          { fieldId: "missing", question: "Missing?", answer: undefined },
        ],
      }),
    ).toBe(
      [
        "1. Name?\n\n   Acme",
        '2. Tags?\n\n   ["alpha","beta"]',
        "3. Optional?\n\n   _Skipped_",
        "4. Missing?\n\n   _Skipped_",
      ].join("\n\n"),
    );
  });
});
