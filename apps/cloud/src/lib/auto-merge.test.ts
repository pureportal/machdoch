import { describe, expect, it } from "vitest";
import {
  autoMergeDecision,
  codeOwnerTeams,
  codeOwners,
  parseCodeOwners,
  type AutoMergeInput,
  type GitMergePolicy,
} from "./auto-merge";

const codeOwnersFixture = `
# Default owners
*                   @acme/maintainers
*.md                @docs-writer
/locales/           @acme/i18n
docs/*              @docs-writer
apps/               @app-owner
/build/logs/        @ops
**/generated/**
`;

const rules = parseCodeOwners(codeOwnersFixture);

const protectedBranch: GitMergePolicy = {
  requiredChecks: ["build", "unit"],
  requiredApprovals: 1,
  codeOwnerReviews: true,
  mergeQueue: false,
};

function input(fields: Partial<AutoMergeInput> = {}): AutoMergeInput {
  return {
    policy: protectedBranch,
    runs: [
      { name: "build", state: "success", url: null },
      { name: "unit", state: "success", url: null },
      { name: "lint", state: "failure", url: null },
    ],
    reviews: [
      { author: "lena", state: "APPROVED", submittedAt: null },
      { author: "app-owner", state: "APPROVED", submittedAt: null },
    ],
    files: ["locales/de.json", "src/apps/web/index.ts"],
    codeOwners: rules,
    teams: new Map([["acme/i18n", ["Lena"]]]),
    ...fields,
  };
}

describe("CODEOWNERS", () => {
  it("lets the last matching pattern decide who owns a file", () => {
    expect(codeOwners(rules, "src/index.ts")).toEqual(["@acme/maintainers"]);
    expect(codeOwners(rules, "README.md")).toEqual(["@docs-writer"]);
    expect(codeOwners(rules, "locales/de/app.json")).toEqual(["@acme/i18n"]);
    expect(codeOwners(rules, "src/locales/de.json")).toEqual([
      "@acme/maintainers",
    ]);
    expect(codeOwners(rules, "docs/guide.txt")).toEqual(["@docs-writer"]);
    expect(codeOwners(rules, "docs/api/guide.txt")).toEqual([
      "@acme/maintainers",
    ]);
    expect(codeOwners(rules, "src/apps/web/index.ts")).toEqual(["@app-owner"]);
    expect(codeOwners(rules, "build/logs/today.log")).toEqual(["@ops"]);
    expect(codeOwners(rules, "src/generated/types.ts")).toEqual([]);
  });

  it("lists the teams whose members must be resolved", () => {
    expect(
      codeOwnerTeams(rules, ["locales/de.json", "src/a.ts", "README.md"]),
    ).toEqual(["acme/i18n", "acme/maintainers"]);
  });
});

describe("auto merge", () => {
  it("merges once required checks pass and every changed file has a code owner approval", () => {
    expect(autoMergeDecision(input())).toEqual({ action: "merge" });
  });

  it("waits for required checks that are missing or still running", () => {
    expect(
      autoMergeDecision(
        input({ runs: [{ name: "build", state: "success", url: null }] }),
      ),
    ).toEqual({
      action: "wait",
      reason: "Waiting for the required check unit.",
    });
    expect(
      autoMergeDecision(
        input({
          runs: [
            { name: "build", state: "success", url: null },
            { name: "unit", state: "pending", url: null },
          ],
        }),
      ),
    ).toEqual({ action: "wait", reason: "Waiting for repository checks." });
  });

  it("stops when a required check fails", () => {
    expect(
      autoMergeDecision(
        input({
          runs: [
            { name: "build", state: "success", url: null },
            { name: "unit", state: "failure", url: null },
          ],
        }),
      ),
    ).toMatchObject({ action: "block" });
  });

  it("requires every reported check when the branch names none", () => {
    expect(
      autoMergeDecision(
        input({ policy: { ...protectedBranch, requiredChecks: [] } }),
      ),
    ).toMatchObject({ action: "block" });
  });

  it("waits for a code owner approval on each owned file", () => {
    expect(
      autoMergeDecision(
        input({
          reviews: [{ author: "lena", state: "APPROVED", submittedAt: null }],
        }),
      ),
    ).toEqual({
      action: "wait",
      reason: "Waiting for a code owner review from @app-owner.",
    });
    expect(
      autoMergeDecision(input({ teams: new Map([["acme/i18n", ["mia"]]]) })),
    ).toEqual({
      action: "wait",
      reason: "Waiting for a code owner review from @acme/i18n.",
    });
  });

  it("waits for the required number of approvals and stops on requested changes", () => {
    expect(
      autoMergeDecision(
        input({
          policy: {
            ...protectedBranch,
            codeOwnerReviews: false,
            requiredApprovals: 3,
          },
        }),
      ),
    ).toEqual({ action: "wait", reason: "Waiting for 1 more approval." });
    expect(
      autoMergeDecision(
        input({
          reviews: [
            { author: "app-owner", state: "APPROVED", submittedAt: null },
            { author: "lena", state: "CHANGES_REQUESTED", submittedAt: null },
          ],
        }),
      ),
    ).toEqual({ action: "block", reason: "lena requested changes." });
  });

  it("ignores reviews when the branch does not require them", () => {
    expect(
      autoMergeDecision(
        input({
          policy: {
            ...protectedBranch,
            codeOwnerReviews: false,
            requiredApprovals: 0,
          },
          reviews: [],
        }),
      ),
    ).toEqual({ action: "merge" });
  });

  it("joins the merge queue instead of merging when the branch uses one", () => {
    expect(
      autoMergeDecision(
        input({ policy: { ...protectedBranch, mergeQueue: true } }),
      ),
    ).toEqual({ action: "enqueue" });
  });
});
