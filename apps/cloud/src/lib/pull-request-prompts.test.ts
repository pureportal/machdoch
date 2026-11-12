import { describe, expect, it } from "vitest";
import {
  pullRequestChecksPrompt,
  pullRequestConflictPrompt,
  pullRequestReviewPrompt,
  pullRequestSessionTitle,
} from "./pull-request-prompts";

const pullRequest = {
  repository: "acme/app",
  number: 12,
  title: "Sign in with passkeys",
  url: "https://github.com/acme/app/pull/12",
  headRef: "plat-1-sign-in",
  baseRef: "main",
};
const issues = [
  {
    identifier: "PLAT-1",
    title: "Sign in",
    url: "https://cloud.example.test/cloud/issues/issue-1",
  },
  {
    identifier: "PLAT-2",
    title: "Passkeys",
    url: "https://cloud.example.test/cloud/issues/issue-2",
  },
];

describe("pull request agent prompts", () => {
  it("asks to merge the base branch into the head branch and push it", () => {
    const prompt = pullRequestConflictPrompt(pullRequest, issues);
    expect(prompt).toContain(
      "Resolve the merge conflicts in acme/app#12: Sign in with passkeys\nhttps://github.com/acme/app/pull/12",
    );
    expect(prompt).toContain(
      "Check out plat-1-sign-in, merge origin/main into it",
    );
    expect(prompt).toContain("commit and push plat-1-sign-in.");
    expect(prompt).toContain(`PLAT-1: Sign in\n${issues[0]!.url}`);
    expect(prompt.endsWith(`PLAT-2: Passkeys\n${issues[1]!.url}`)).toBe(true);
  });

  it("lists failing checks with their links", () => {
    const prompt = pullRequestChecksPrompt(
      pullRequest,
      [
        { name: "lint", state: "failure", url: "https://github.com/runs/1" },
        { name: "e2e", state: "failure", url: null },
      ],
      issues.slice(0, 1),
    );
    expect(prompt).toContain(
      "Fix the failing checks on acme/app#12: Sign in with passkeys",
    );
    expect(prompt).toContain("lint: https://github.com/runs/1\ne2e");
    expect(prompt).toContain(
      "Check out plat-1-sign-in, reproduce each failure",
    );
  });

  it("lists every review comment with its location, author and link", () => {
    const prompt = pullRequestReviewPrompt(
      pullRequest,
      [
        {
          id: 1,
          author: "reviewer",
          body: "  Rename this value.\n",
          path: "src/sign-in.ts",
          line: 3,
          diffHunk: "@@ -1 +1 @@",
          url: "https://github.com/acme/app/pull/12#discussion_r1",
          createdAt: "2026-11-01T10:00:00Z",
        },
        {
          id: 2,
          author: "lead",
          body: "Split this file.",
          path: "src/passkeys.ts",
          line: null,
          diffHunk: "@@ -1 +1 @@",
          url: "https://github.com/acme/app/pull/12#discussion_r2",
          createdAt: "2026-11-01T11:00:00Z",
        },
      ],
      issues.slice(0, 1),
    );
    expect(prompt).toContain(
      "src/sign-in.ts:3 (reviewer)\nRename this value.\nhttps://github.com/acme/app/pull/12#discussion_r1",
    );
    expect(prompt).toContain(
      "src/passkeys.ts (lead)\nSplit this file.\nhttps://github.com/acme/app/pull/12#discussion_r2",
    );
    expect(prompt).toContain("Make the requested changes on plat-1-sign-in");
  });

  it("names sessions after the first issue and the pull request", () => {
    expect(pullRequestSessionTitle("conflicts", pullRequest, issues)).toBe(
      "PLAT-1 Resolve conflicts in acme/app#12",
    );
    expect(pullRequestSessionTitle("checks", pullRequest, issues)).toBe(
      "PLAT-1 Fix checks on acme/app#12",
    );
    expect(pullRequestSessionTitle("review", pullRequest, [])).toBe(
      "Address review on acme/app#12",
    );
  });
});
