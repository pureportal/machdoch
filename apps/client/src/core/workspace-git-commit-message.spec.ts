import { describe, expect, it } from "vitest";
import {
  formatCommitMessagePrompt,
  readCommitMessage,
  truncateStagedDiff,
} from "./workspace-git-commit-message.js";

describe("workspace git commit message", () => {
  it("cuts long diffs at a file boundary", () => {
    const diff = `diff --git a/a b/a\n${"+a\n".repeat(20)}diff --git a/b b/b\n${"+b\n".repeat(20)}`;
    const truncated = truncateStagedDiff(diff, 70);
    expect(truncated.startsWith("diff --git a/a b/a")).toBe(true);
    expect(truncated).not.toContain("diff --git a/b");
    expect(truncated).toMatch(/more characters of diff omitted\]$/u);
    expect(truncateStagedDiff("short", 70)).toBe("short");
  });

  it("includes recent subjects and the staged diff in the prompt", () => {
    const prompt = formatCommitMessagePrompt({
      stat: " a.ts | 2 +-\n",
      diff: "diff --git a/a.ts b/a.ts",
      recentSubjects: ["🐛 Fix login", "✨ Add search"],
    });
    expect(prompt).toContain("- 🐛 Fix login");
    expect(prompt).toContain("a.ts | 2 +-");
    expect(prompt).toContain("diff --git a/a.ts b/a.ts");
  });

  it("cleans fences, quotes and trailing periods from model output", () => {
    expect(readCommitMessage("```\nFix the parser.\n\nExplain why.\n```")).toBe(
      "Fix the parser\n\nExplain why.",
    );
    expect(readCommitMessage('"Add tags"')).toBe("Add tags");
    expect(() => readCommitMessage("   ")).toThrow(/empty commit message/u);
  });
});
