import { describe, expect, it } from "vitest";
import {
  compareCanonicalStrings,
  digestJson,
  stableJson,
} from "./digests.js";

describe("canonical JSON digests", () => {
  it("sorts object keys by raw code units instead of host locale collation", () => {
    const value = Object.fromEntries([
      ["ı", 4],
      ["i", 3],
      ["İ", 2],
      ["I", 1],
    ]);

    expect(stableJson(value)).toBe('{"I":1,"i":3,"İ":2,"ı":4}');
    expect(
      ["ı", "i", "İ", "I"].sort(compareCanonicalStrings),
    ).toEqual(["I", "i", "İ", "ı"]);
  });

  it("produces the same digest for insertion-order permutations", () => {
    const first = {
      z: { beta: 2, alpha: 1 },
      A: true,
      ä: ["stable"],
    };
    const second = {
      ä: ["stable"],
      A: true,
      z: { alpha: 1, beta: 2 },
    };

    expect(stableJson(first)).toBe(
      '{"A":true,"z":{"alpha":1,"beta":2},"ä":["stable"]}',
    );
    expect(digestJson(first)).toBe(digestJson(second));
  });
});
