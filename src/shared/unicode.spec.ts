import { describe, expect, it } from "vitest";
import {
  hasUnpairedUtf16Surrogate,
  sliceUtf16PrefixAtCodePointBoundary,
  sliceUtf16SuffixAtCodePointBoundary,
} from "./unicode.js";

describe("Unicode scalar validation", () => {
  it("accepts surrogate pairs and rejects isolated surrogates", () => {
    expect(hasUnpairedUtf16Surrogate("valid 😀 text")).toBe(false);
    expect(hasUnpairedUtf16Surrogate("leading\udc00")).toBe(true);
    expect(hasUnpairedUtf16Surrogate("trailing\ud800")).toBe(true);
    expect(hasUnpairedUtf16Surrogate("split\ud800value")).toBe(true);
  });

  it("does not split surrogate pairs at prefix or suffix limits", () => {
    const fox = "\ud83e\udd8a";
    expect(sliceUtf16PrefixAtCodePointBoundary(`a${fox}b`, 2)).toBe("a");
    expect(sliceUtf16PrefixAtCodePointBoundary(`a${fox}b`, 3)).toBe(`a${fox}`);
    expect(sliceUtf16SuffixAtCodePointBoundary(`a${fox}b`, 2)).toBe("b");
    expect(sliceUtf16SuffixAtCodePointBoundary(`a${fox}b`, 3)).toBe(`${fox}b`);
    expect(sliceUtf16PrefixAtCodePointBoundary("abc", 2)).toBe("ab");
    expect(sliceUtf16SuffixAtCodePointBoundary("abc", 2)).toBe("bc");
  });
});
