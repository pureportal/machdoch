import { describe, expect, it } from "vitest";
import {
  highlightSegments,
  parseQuickOpenQuery,
} from "./workspace-quick-open-model";

describe("quick open model", () => {
  it("splits an optional line suffix from the file pattern", () => {
    expect(parseQuickOpenQuery("main.ts")).toEqual({
      pattern: "main.ts",
      line: undefined,
    });
    expect(parseQuickOpenQuery("src/main.ts:42")).toEqual({
      pattern: "src/main.ts",
      line: 42,
    });
    expect(parseQuickOpenQuery(":0")).toEqual({ pattern: "", line: 1 });
  });

  it("groups matched characters and separates the folder part", () => {
    expect(highlightSegments("src/main.ts", [4, 5], 4)).toEqual([
      { text: "src/", highlighted: false, directory: true },
      { text: "ma", highlighted: true, directory: false },
      { text: "in.ts", highlighted: false, directory: false },
    ]);
  });
});
