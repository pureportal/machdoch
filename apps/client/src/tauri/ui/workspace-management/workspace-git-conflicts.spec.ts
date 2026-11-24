import { describe, expect, it } from "vitest";
import {
  hasConflictMarkers,
  parseConflictText,
  resolveAllConflicts,
  resolveConflictRegion,
} from "./workspace-git-conflicts";

const conflicted = [
  "header",
  "<<<<<<< HEAD",
  "ours one",
  "=======",
  "theirs one",
  ">>>>>>> feature",
  "middle",
  "<<<<<<< HEAD",
  "ours two",
  "||||||| base",
  "base two",
  "=======",
  "theirs two",
  ">>>>>>> feature",
  "footer",
  "",
].join("\r\n");

describe("merge conflict resolution", () => {
  it("finds conflict regions with diff3 bases and labels", () => {
    const parsed = parseConflictText(conflicted);
    expect(parsed.regions).toHaveLength(2);
    expect(parsed.regions[0]).toMatchObject({
      ours: ["ours one"],
      theirs: ["theirs one"],
      base: null,
      oursLabel: "HEAD",
      theirsLabel: "feature",
    });
    expect(parsed.regions[1]?.base).toEqual(["base two"]);
  });

  it("accepts ours or theirs per hunk and keeps line endings", () => {
    const first = resolveConflictRegion(conflicted, 0, "theirs");
    expect(
      first.startsWith("header\r\ntheirs one\r\nmiddle\r\n<<<<<<< HEAD"),
    ).toBe(true);
    expect(hasConflictMarkers(first)).toBe(true);
    const both = resolveConflictRegion(first, 0, "both");
    expect(both).toContain("ours two\r\ntheirs two");
    expect(hasConflictMarkers(both)).toBe(false);
  });

  it("accepts one side for the whole file", () => {
    expect(resolveAllConflicts(conflicted, "ours")).toBe(
      "header\r\nours one\r\nmiddle\r\nours two\r\nfooter\r\n",
    );
    expect(resolveAllConflicts(conflicted, "base")).toBe(
      "header\r\nmiddle\r\nbase two\r\nfooter\r\n",
    );
  });

  it("leaves unterminated markers untouched", () => {
    const text = "a\n<<<<<<< HEAD\nb\n";
    expect(parseConflictText(text).regions).toHaveLength(0);
    expect(resolveAllConflicts(text, "ours")).toBe(text);
  });
});
