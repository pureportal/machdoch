import { describe, expect, it } from "vitest";
import {
  pullRequestConflictPrompt,
  pullRequestConflictSessionTitle,
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

  it("names sessions after the first issue and the pull request", () => {
    expect(pullRequestConflictSessionTitle(pullRequest, issues)).toBe(
      "PLAT-1 Resolve conflicts in acme/app#12",
    );
    expect(pullRequestConflictSessionTitle(pullRequest, [])).toBe(
      "Resolve conflicts in acme/app#12",
    );
  });
});
