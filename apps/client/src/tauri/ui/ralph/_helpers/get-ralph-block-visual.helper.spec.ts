import { describe, expect, it } from "vitest";

import { getRalphOutputTone } from "./get-ralph-block-visual.helper";

describe("Ralph output tones", () => {
  it.each([
    ["SUCCESS", "emerald"],
    ["DONE", "emerald"],
    ["RETRY", "amber"],
    ["TIMEOUT", "orange"],
    ["EMPTY", "slate"],
    ["HTTP_ERROR", "rose"],
    ["CANCELLED", "violet"],
    ["CUSTOM_BRANCH", "cyan"],
  ] as const)("maps %s to %s", (output, tone) => {
    expect(getRalphOutputTone(output)).toBe(tone);
  });
});
