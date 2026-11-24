import { describe, expect, it } from "vitest";
import type {
  CloudLinkedIssue,
  CloudPullRequest,
  GitCheckRun,
} from "./cloud-git-contract";
import { checksSummary, pullRequestHeader } from "./pull-request-header";
import { pullRequestStacks, type StackCandidate } from "./pull-request-stacks";

function candidate(
  id: string,
  headRef: string,
  baseRef: string,
): StackCandidate {
  return {
    id,
    repositoryId: "repo",
    number: Number(id.slice(1)),
    title: id,
    headRef,
    baseRef,
    state: "open",
    updatedAt: "2026-11-01T10:00:00.000Z",
  };
}

function issue(identifier: string, closes: boolean): CloudLinkedIssue {
  return {
    id: identifier,
    identifier,
    title: identifier,
    statusName: "In Progress",
    state: "active",
    closes,
  };
}

function run(name: string, state: GitCheckRun["state"]): GitCheckRun {
  return { name, state, url: null };
}

const stacks = pullRequestStacks([
  candidate("p1", "feature/a", "main"),
  candidate("p2", "feature/b", "feature/a"),
  candidate("p3", "feature/c", "feature/b"),
  candidate("p4", "feature/d", "feature/c"),
]);

function pullRequest(fields: Partial<CloudPullRequest>): CloudPullRequest {
  return {
    id: "p2",
    provider: "github",
    repository: "acme/app",
    number: 2,
    title: "Refresh sessions",
    url: "https://github.com/acme/app/pull/2",
    state: "open",
    draft: false,
    author: "ada",
    headRef: "feature/b",
    headSha: "a".repeat(40),
    baseRef: "feature/a",
    defaultBranch: "main",
    mergeableState: "clean",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    checks: "failure",
    review: "none",
    stage: "attention",
    closes: true,
    mergedAt: null,
    updatedAt: "2026-11-01T10:00:00.000Z",
    requestedReviewers: [],
    stack: stacks.get("p2") ?? null,
    ...fields,
  };
}

describe("pullRequestHeader", () => {
  it("tells human, Copilot and machdoch agent reviewers apart", () => {
    const header = pullRequestHeader({
      pullRequest: pullRequest({
        requestedReviewers: ["Copilot", "grace", "ACME-BOT"],
      }),
      reviews: [
        { author: "ada", state: "APPROVED", submittedAt: null },
        {
          author: "copilot-pull-request-reviewer[bot]",
          state: "COMMENTED",
          submittedAt: null,
        },
        { author: "acme-bot", state: "CHANGES_REQUESTED", submittedAt: null },
      ],
      checks: { conclusion: "none", runs: [] },
      issues: [],
      agentLogin: "acme-bot",
    });
    expect(header.reviewers).toEqual([
      { login: "ada", state: "approved", kind: "human" },
      { login: "ACME-BOT", state: "pending", kind: "agent" },
      { login: "Copilot", state: "pending", kind: "copilot" },
      { login: "grace", state: "pending", kind: "human" },
    ]);
  });

  it("summarises checks with failures first, then running checks", () => {
    expect(checksSummary([])).toEqual({ state: "none", label: "No checks" });
    expect(
      checksSummary([
        run("lint", "success"),
        run("test", "failure"),
        run("build", "pending"),
      ]),
    ).toEqual({ state: "failure", label: "1 of 3 failed" });
    expect(
      checksSummary([run("lint", "success"), run("build", "pending")]),
    ).toEqual({ state: "pending", label: "1 of 2 running" });
    expect(
      checksSummary([run("lint", "success"), run("docs", "skipped")]),
    ).toEqual({ state: "success", label: "2 passed" });
  });

  it("lists only the issues the pull request resolves", () => {
    const header = pullRequestHeader({
      pullRequest: pullRequest({}),
      reviews: [],
      checks: { conclusion: "none", runs: [] },
      issues: [issue("ENG-1", true), issue("ENG-2", false)],
      agentLogin: "acme-bot",
    });
    expect(header.resolves.map((entry) => entry.identifier)).toEqual(["ENG-1"]);
  });

  it("places the pull request within its whole stack", () => {
    const details = {
      reviews: [],
      checks: { conclusion: "none" as const, runs: [] },
      issues: [],
      agentLogin: "acme-bot",
    };
    expect(
      pullRequestHeader({ ...details, pullRequest: pullRequest({}) }).stack,
    ).toEqual({ position: 2, size: 4 });
    expect(
      pullRequestHeader({
        ...details,
        pullRequest: pullRequest({ id: "p1", stack: stacks.get("p1")! }),
      }).stack,
    ).toEqual({ position: 1, size: 4 });
    expect(
      pullRequestHeader({
        ...details,
        pullRequest: pullRequest({ stack: null }),
      }).stack,
    ).toBeNull();
    expect(
      pullRequestHeader({
        ...details,
        pullRequest: pullRequest({ state: "merged" }),
      }).stack,
    ).toBeNull();
  });
});
