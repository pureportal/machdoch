import { describe, expect, it } from "vitest";
import { clampRalphGenerationInterviewMaxTurns } from "./clamp-ralph-generation-interview-max-turns.helper.js";

const defaults = { defaultMaxTurns: 5, maxTurns: 8 };

describe("clampRalphGenerationInterviewMaxTurns", () => {
  it("uses the default for missing or non-integer values", () => {
    expect(clampRalphGenerationInterviewMaxTurns(undefined, defaults)).toBe(5);
    expect(clampRalphGenerationInterviewMaxTurns(2.5, defaults)).toBe(5);
  });

  it("clamps values to the supported bounds", () => {
    expect(clampRalphGenerationInterviewMaxTurns(-1, defaults)).toBe(1);
    expect(clampRalphGenerationInterviewMaxTurns(0, defaults)).toBe(1);
    expect(clampRalphGenerationInterviewMaxTurns(4, defaults)).toBe(4);
    expect(clampRalphGenerationInterviewMaxTurns(99, defaults)).toBe(8);
  });
});
