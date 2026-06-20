import { extractRalphInterviewJsonObject } from "./extract-ralph-interview-json-object.helper.ts";

describe("extractRalphInterviewJsonObject", () => {
  it("parses raw and fenced JSON objects", () => {
    expect(extractRalphInterviewJsonObject('{"complete":true}')).toEqual({
      complete: true,
    });
    expect(
      extractRalphInterviewJsonObject(
        '```json\n{"complete":false,"questions":[]}\n```',
      ),
    ).toEqual({ complete: false, questions: [] });
  });

  it("extracts the first object from surrounding text", () => {
    expect(
      extractRalphInterviewJsonObject('before {"summary":"ok"} after'),
    ).toEqual({ summary: "ok" });
  });

  it("throws for empty, missing, and malformed JSON", () => {
    expect(() => extractRalphInterviewJsonObject("")).toThrow(
      "Interview AI response did not contain valid JSON.",
    );
    expect(() => extractRalphInterviewJsonObject("no object here")).toThrow(
      "Interview AI response did not contain valid JSON.",
    );
    expect(() => extractRalphInterviewJsonObject('{"complete":')).toThrow();
  });
});
