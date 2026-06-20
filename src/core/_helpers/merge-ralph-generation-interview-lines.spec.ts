import { describe, expect, it } from "vitest";
import { mergeRalphGenerationInterviewLines } from "./merge-ralph-generation-interview-lines.helper.js";

describe("mergeRalphGenerationInterviewLines", () => {
  it("keeps current lines and appends only case-insensitive new lines", () => {
    expect(
      mergeRalphGenerationInterviewLines(
        ["Existing finding", "Second finding"],
        ["existing finding", "New finding"],
      ),
    ).toEqual(["Existing finding", "Second finding", "New finding"]);
  });

  it("keeps the most recent twenty merged lines", () => {
    const current = Array.from({ length: 19 }, (_, index) => `current-${index}`);
    const merged = mergeRalphGenerationInterviewLines(current, [
      "incoming-1",
      "incoming-2",
      "incoming-3",
    ]);

    expect(merged).toHaveLength(20);
    expect(merged[0]).toBe("current-2");
    expect(merged.at(-1)).toBe("incoming-3");
  });

  it("handles empty inputs", () => {
    expect(mergeRalphGenerationInterviewLines([], [])).toEqual([]);
    expect(mergeRalphGenerationInterviewLines(["one"], [])).toEqual(["one"]);
    expect(mergeRalphGenerationInterviewLines([], ["one"])).toEqual(["one"]);
  });
});
