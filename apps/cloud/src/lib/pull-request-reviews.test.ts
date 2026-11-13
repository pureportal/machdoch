import { describe, expect, it } from "vitest";
import { pullRequestReviewers, reviewGroup } from "./pull-request-reviews";

const accounts = [{ provider: "github" as const, login: "Alex" }];
const base = {
  provider: "github" as const,
  author: "sam",
  requestedReviewers: [] as string[],
  state: "open" as const,
  stage: "review" as const,
};

describe("pullRequestReviewers", () => {
  it("combines decisions with pending requests", () => {
    expect(
      pullRequestReviewers(
        ["Riley", "sam"],
        [
          { author: "alex", state: "APPROVED" },
          { author: "Sam", state: "CHANGES_REQUESTED" },
          { author: "kim", state: "COMMENTED" },
        ],
      ),
    ).toEqual([
      { login: "alex", state: "approved" },
      { login: "sam", state: "pending" },
      { login: "Riley", state: "pending" },
    ]);
  });
});

describe("reviewGroup", () => {
  it("asks for my review when I am a requested reviewer", () => {
    expect(
      reviewGroup({ ...base, requestedReviewers: ["alex"] }, accounts),
    ).toBe("requested");
  });

  it("ignores pull requests that do not involve me", () => {
    expect(reviewGroup(base, accounts)).toBeNull();
    expect(
      reviewGroup(
        { ...base, requestedReviewers: ["alex"], state: "merged" },
        accounts,
      ),
    ).toBeNull();
  });

  it("matches logins only on the same provider", () => {
    expect(
      reviewGroup(
        { ...base, provider: "gitlab", requestedReviewers: ["alex"] },
        accounts,
      ),
    ).toBeNull();
  });

  it("groups my pull requests by what they need", () => {
    const mine = { ...base, author: "ALEX" };
    expect(reviewGroup(mine, accounts)).toBe("waiting");
    expect(reviewGroup({ ...mine, stage: "attention" }, accounts)).toBe(
      "attention",
    );
    expect(reviewGroup({ ...mine, stage: "ready" }, accounts)).toBe("ready");
    expect(reviewGroup({ ...mine, stage: "draft" }, accounts)).toBe("draft");
    expect(
      reviewGroup({ ...mine, state: "closed", stage: "closed" }, accounts),
    ).toBe("done");
  });
});
