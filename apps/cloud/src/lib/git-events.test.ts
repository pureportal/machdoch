import { describe, expect, it } from "vitest";
import {
  automationMarker,
  branchMatches,
  gitEventMatches,
  gitEventVariables,
  isAutomationText,
  isPullRequestEvent,
  pullRequestLifecycleEvents,
  type GitEvent,
  type GitEventFilter,
} from "./git-events";

const event: GitEvent = {
  kind: "push",
  provider: "github",
  repositoryId: "repo-1",
  repository: "acme/app",
  repositoryUrl: "https://github.com/acme/app",
  defaultBranch: "main",
  branch: "main",
  sender: "Octocat",
  pullRequest: null,
  push: {
    before: "a".repeat(40),
    after: "b".repeat(40),
    forced: false,
    compareUrl: "https://github.com/acme/app/compare/a...b",
    commits: [
      { id: "c".repeat(40), message: "Fix sign-in\n\nDetails", author: "Ada" },
    ],
  },
  review: null,
  comment: null,
  tag: null,
  parent: null,
  issueIds: [],
};

const filter: GitEventFilter = {
  events: ["push"],
  repositoryIds: [],
  branches: [],
  headBranches: [],
  actors: [],
  contains: "",
};

describe("branchMatches", () => {
  it("matches everything without patterns and nothing without a branch", () => {
    expect(branchMatches([], "feature/a", "main")).toBe(true);
    expect(branchMatches(["main"], null, "main")).toBe(false);
  });

  it("supports globs, the default branch token and exclusions", () => {
    expect(branchMatches(["release/*"], "release/1.2", "main")).toBe(true);
    expect(branchMatches(["release/*"], "release/1/hotfix", "main")).toBe(
      false,
    );
    expect(branchMatches(["release/**"], "release/1/hotfix", "main")).toBe(
      true,
    );
    expect(branchMatches(["$default"], "trunk", "trunk")).toBe(true);
    expect(branchMatches(["!$default"], "feature/x", "main")).toBe(true);
    expect(branchMatches(["!$default"], "main", "main")).toBe(false);
    expect(
      branchMatches(["feature/*", "!feature/wip"], "feature/wip", "main"),
    ).toBe(false);
    expect(branchMatches(["v?.x"], "v1.x", "main")).toBe(true);
    expect(branchMatches(["a.b"], "aXb", "main")).toBe(false);
  });
});

describe("gitEventMatches", () => {
  it("filters by event, repository, branch, actor and text", () => {
    expect(gitEventMatches(filter, event)).toBe(true);
    expect(gitEventMatches({ ...filter, events: ["tag_created"] }, event)).toBe(
      false,
    );
    expect(
      gitEventMatches({ ...filter, repositoryIds: ["repo-2"] }, event),
    ).toBe(false);
    expect(gitEventMatches({ ...filter, branches: ["!$default"] }, event)).toBe(
      false,
    );
    expect(gitEventMatches({ ...filter, actors: ["octocat"] }, event)).toBe(
      true,
    );
    expect(gitEventMatches({ ...filter, actors: ["hubot"] }, event)).toBe(
      false,
    );
    expect(gitEventMatches({ ...filter, contains: "SIGN-IN" }, event)).toBe(
      true,
    );
  });

  it("matches head branches of pull requests only", () => {
    const opened: GitEvent = {
      ...event,
      kind: "pull_request_opened",
      branch: "feature/base",
      push: null,
      pullRequest: {
        id: "pr-1",
        number: 4,
        title: "Stacked change",
        url: "https://github.com/acme/app/pull/4",
        author: "ada",
        headRef: "feature/top",
        baseRef: "feature/base",
        headSha: "d".repeat(40),
        draft: false,
      },
    };
    const pullRequests = {
      ...filter,
      events: ["pull_request_opened" as const],
    };
    expect(
      gitEventMatches(
        {
          ...pullRequests,
          branches: ["!$default"],
          headBranches: ["feature/*"],
        },
        opened,
      ),
    ).toBe(true);
    expect(gitEventMatches({ ...filter, headBranches: ["*"] }, event)).toBe(
      false,
    );
  });
});

it("separates repository and pull request events", () => {
  expect(isPullRequestEvent("push")).toBe(false);
  expect(isPullRequestEvent("tag_created")).toBe(false);
  expect(isPullRequestEvent("review_approved")).toBe(true);
  expect(isPullRequestEvent("stack_base_merged")).toBe(true);
});

it("recognizes text written by automations", () => {
  expect(isAutomationText(`Looks good\n\n${automationMarker}`)).toBe(true);
  expect(isAutomationText("Looks good")).toBe(false);
});

it("exposes template variables with readable commit lists", () => {
  const variables = gitEventVariables(event);
  expect(variables.branch).toBe("main");
  expect(variables.repository).toEqual({
    name: "acme/app",
    url: "https://github.com/acme/app",
  });
  expect((variables.push as { commits: string }).commits).toBe(
    "- ccccccc Fix sign-in (Ada)",
  );
});

describe("pullRequestLifecycleEvents", () => {
  const open = {
    state: "open" as const,
    draft: false,
    headSha: "a".repeat(40),
    checks: null,
  };

  it("reports new, merged, closed and reopened pull requests", () => {
    expect(pullRequestLifecycleEvents(null, open)).toEqual([
      "pull_request_opened",
    ]);
    expect(
      pullRequestLifecycleEvents(open, { ...open, state: "merged" }),
    ).toEqual(["pull_request_merged"]);
    expect(
      pullRequestLifecycleEvents(open, { ...open, state: "closed" }),
    ).toEqual(["pull_request_closed"]);
    expect(
      pullRequestLifecycleEvents({ ...open, state: "closed" }, open),
    ).toEqual(["pull_request_reopened"]);
  });

  it("reports draft changes, new commits and check results once", () => {
    expect(pullRequestLifecycleEvents({ ...open, draft: true }, open)).toEqual([
      "pull_request_ready",
    ]);
    expect(pullRequestLifecycleEvents(open, { ...open, draft: true })).toEqual([
      "pull_request_draft",
    ]);
    expect(
      pullRequestLifecycleEvents(open, { ...open, headSha: "b".repeat(40) }),
    ).toEqual(["pull_request_updated"]);
    expect(
      pullRequestLifecycleEvents(open, { ...open, checks: "failure" }),
    ).toEqual(["checks_failed"]);
    expect(
      pullRequestLifecycleEvents(
        { ...open, checks: "success" },
        { ...open, checks: "success" },
      ),
    ).toEqual([]);
    expect(
      pullRequestLifecycleEvents(
        { ...open, checks: "pending" },
        { ...open, checks: "success" },
      ),
    ).toEqual(["checks_passed"]);
  });
});
