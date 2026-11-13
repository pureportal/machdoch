import { describe, expect, it } from "vitest";
import {
  attentionReasons,
  automationStatus,
  automationTarget,
  checkRunState,
  checksState,
  pullRequestAutomationEvent,
  pullRequestStage,
  reviewDecision,
  type AutomationStatus,
  type PullRequestSignals,
} from "./git-automation";

const open: PullRequestSignals = {
  state: "open",
  draft: false,
  mergeableState: "clean",
  checks: "success",
  review: "none",
};

const statuses: AutomationStatus[] = [
  { id: "backlog", category: "backlog", position: 0, archived: false },
  { id: "todo", category: "ready", position: 1, archived: false },
  { id: "progress", category: "active", position: 2, archived: false },
  { id: "blocked", category: "blocked", position: 3, archived: false },
  { id: "review", category: "review", position: 4, archived: false },
  { id: "approved", category: "review", position: 5, archived: false },
  { id: "old-done", category: "complete", position: 6, archived: true },
  { id: "done", category: "complete", position: 7, archived: false },
  { id: "canceled", category: "canceled", position: 8, archived: false },
];
const status = (id: string) => statuses.find((entry) => entry.id === id)!;

describe("pull request stages", () => {
  it("puts conflicts, failing checks and requested changes first", () => {
    expect(pullRequestStage({ ...open, mergeableState: "dirty" })).toBe(
      "attention",
    );
    expect(pullRequestStage({ ...open, checks: "failure" })).toBe("attention");
    expect(pullRequestStage({ ...open, review: "changes_requested" })).toBe(
      "attention",
    );
  });

  it("is ready only when approved, settled and not blocked by branch rules", () => {
    expect(pullRequestStage({ ...open, review: "approved" })).toBe("ready");
    expect(
      pullRequestStage({ ...open, review: "approved", checks: "none" }),
    ).toBe("ready");
    expect(
      pullRequestStage({ ...open, review: "approved", checks: "pending" }),
    ).toBe("review");
    expect(
      pullRequestStage({
        ...open,
        review: "approved",
        mergeableState: "behind",
      }),
    ).toBe("review");
    expect(
      pullRequestStage({
        ...open,
        review: "approved",
        mergeableState: "blocked",
      }),
    ).toBe("review");
    expect(pullRequestStage(open)).toBe("review");
  });

  it("names every reason a pull request needs attention", () => {
    expect(
      attentionReasons({
        ...open,
        mergeableState: "dirty",
        checks: "failure",
        review: "changes_requested",
      }),
    ).toEqual(["conflicts", "checks", "changes"]);
    expect(attentionReasons({ ...open, checks: "failure" })).toEqual([
      "checks",
    ]);
    expect(
      attentionReasons({ ...open, draft: true, checks: "failure" }),
    ).toEqual([]);
  });

  it("keeps drafts, merged and closed pull requests in their own stages", () => {
    expect(pullRequestStage({ ...open, draft: true, checks: "failure" })).toBe(
      "draft",
    );
    expect(pullRequestStage({ ...open, state: "merged" })).toBe("merged");
    expect(pullRequestStage({ ...open, state: "closed" })).toBe("closed");
  });
});

describe("pull request automation", () => {
  it("derives the event from state, draft and review", () => {
    expect(pullRequestAutomationEvent({ ...open, draft: true }, false)).toBe(
      "draft",
    );
    expect(pullRequestAutomationEvent(open, false)).toBe("open");
    expect(
      pullRequestAutomationEvent({ ...open, review: "approved" }, true),
    ).toBe("approved");
    expect(pullRequestAutomationEvent({ ...open, state: "merged" }, true)).toBe(
      "merged",
    );
    expect(
      pullRequestAutomationEvent({ ...open, state: "merged" }, false),
    ).toBeNull();
    expect(
      pullRequestAutomationEvent({ ...open, state: "closed" }, true),
    ).toBeNull();
  });

  it("uses the first active status of each default category", () => {
    expect(automationStatus("draft", undefined, statuses)?.id).toBe("progress");
    expect(automationStatus("open", undefined, statuses)?.id).toBe("review");
    expect(automationStatus("approved", undefined, statuses)).toBeNull();
    expect(automationStatus("merged", undefined, statuses)?.id).toBe("done");
  });

  it("honors team rules and ignores unusable statuses", () => {
    expect(automationStatus("approved", "approved", statuses)?.id).toBe(
      "approved",
    );
    expect(automationStatus("open", null, statuses)).toBeNull();
    expect(automationStatus("merged", "old-done", statuses)).toBeNull();
    expect(automationStatus("open", "blocked", statuses)).toBeNull();
    expect(automationStatus("open", "missing", statuses)).toBeNull();
  });

  it("only moves issues forward, including within a category", () => {
    expect(
      automationTarget("open", undefined, statuses, status("backlog"))?.id,
    ).toBe("review");
    expect(
      automationTarget("approved", "approved", statuses, status("review"))?.id,
    ).toBe("approved");
    expect(
      automationTarget("open", undefined, statuses, status("approved")),
    ).toBeNull();
    expect(
      automationTarget("draft", undefined, statuses, status("review")),
    ).toBeNull();
    expect(
      automationTarget("merged", undefined, statuses, status("done")),
    ).toBeNull();
    expect(
      automationTarget("merged", undefined, statuses, status("blocked")),
    ).toBeNull();
    expect(
      automationTarget("merged", undefined, statuses, status("canceled")),
    ).toBeNull();
  });
});

describe("GitHub review and check summaries", () => {
  it("lets requested changes outweigh approvals", () => {
    expect(reviewDecision(["APPROVED", "CHANGES_REQUESTED"])).toBe(
      "changes_requested",
    );
    expect(reviewDecision(["APPROVED", "DISMISSED"])).toBe("approved");
    expect(reviewDecision(["DISMISSED"])).toBe("none");
  });

  it("fails on any failed run and waits for running ones", () => {
    expect(checkRunState("in_progress", null)).toBe("pending");
    expect(checkRunState("completed", "timed_out")).toBe("failure");
    expect(checkRunState("completed", "skipped")).toBe("skipped");
    expect(checksState([])).toBe("none");
    expect(checksState(["success", "pending", "failure"])).toBe("failure");
    expect(checksState(["success", "pending"])).toBe("pending");
    expect(checksState(["success", "skipped"])).toBe("success");
  });
});
