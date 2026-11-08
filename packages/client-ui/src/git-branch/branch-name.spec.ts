import { describe, expect, it } from "vitest";
import { isValidGitBranchName } from "./branch-name";

describe("Git branch names", () => {
  it("accepts only names Git allows for branches", () => {
    for (const name of [
      "main",
      "feature/ABC-123-checkout",
      "release/1.4",
      "user@host",
    ]) {
      expect(isValidGitBranchName(name)).toBe(true);
    }
    for (const name of [
      "",
      "HEAD",
      "@",
      "-feature",
      "feature branch",
      "feature..x",
      "feature/",
      "/feature",
      "feature//x",
      "feature.",
      "feature/.hidden",
      "feature/x.lock",
      "feature@{1}",
      "feature~1",
      "feature^",
      "feature:x",
      "feature?",
      "feature*",
      "feature[x",
      "feature\\x",
      "feature\tx",
      "x".repeat(256),
    ]) {
      expect(isValidGitBranchName(name)).toBe(false);
    }
  });
});
