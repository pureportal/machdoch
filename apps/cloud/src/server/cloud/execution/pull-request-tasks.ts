import type { PullRequestTask } from "@machdoch/fleet-protocol/cloud-execution";

export const sandboxStatusContext = "machdoch/sandbox";

export const pullRequestTaskDefaults: Record<
  PullRequestTask,
  { objective: string; acceptanceCriteria: string }
> = {
  check: {
    objective:
      "Check this pull request before it is merged. Install what it needs, build it and run its tests and checks. Read the changed code and look for bugs, regressions, security problems, broken edge cases and missing tests. If it changes a user interface and a browser is available in the sandbox, start the app and inspect the affected screens for visual problems. Do not fix anything; report what you find.",
    acceptanceCriteria:
      "Every problem is reported with the file, the evidence and why it matters. Commands that could not run are reported as not run.",
  },
  fix: {
    objective:
      "Fix the failing checks and address the review comments on this pull request.",
    acceptanceCriteria:
      "The checks pass and every review comment is addressed.",
  },
  resolve: {
    objective:
      "The base branch was merged into this pull request's working tree and left conflicts. Resolve every conflict so both sides' intent is kept, remove all conflict markers, and make the project build and its tests pass.",
    acceptanceCriteria:
      "No conflict markers remain, the base branch's changes are kept, and the checks pass.",
  },
};
