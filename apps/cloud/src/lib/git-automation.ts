import type { CloudIssue } from "./cloud-contract";

export type PullRequestState = "open" | "closed" | "merged";
export const gitChecksStates = [
  "success",
  "failure",
  "pending",
  "none",
] as const;
export type GitChecksState = (typeof gitChecksStates)[number];
export const gitReviewDecisions = [
  "approved",
  "changes_requested",
  "none",
] as const;
export type GitReviewDecision = (typeof gitReviewDecisions)[number];

export const pullRequestStages = [
  "attention",
  "ready",
  "review",
  "draft",
  "merged",
  "closed",
] as const;
export type PullRequestStage = (typeof pullRequestStages)[number];

export interface PullRequestSignals {
  state: PullRequestState;
  draft: boolean;
  mergeableState: string | null;
  checks: GitChecksState | null;
  review: GitReviewDecision | null;
}

const blockedMergeStates = new Set(["dirty", "blocked", "behind", "draft"]);

export function pullRequestStage(
  pullRequest: PullRequestSignals,
): PullRequestStage {
  if (pullRequest.state !== "open") return pullRequest.state;
  if (pullRequest.draft) return "draft";
  if (
    pullRequest.mergeableState === "dirty" ||
    pullRequest.checks === "failure" ||
    pullRequest.review === "changes_requested"
  )
    return "attention";
  if (
    pullRequest.review === "approved" &&
    pullRequest.checks !== "pending" &&
    !blockedMergeStates.has(pullRequest.mergeableState ?? "")
  )
    return "ready";
  return "review";
}

export const gitStatusEvents = ["draft", "open", "approved", "merged"] as const;
export type GitStatusEvent = (typeof gitStatusEvents)[number];

export const defaultAutomationCategories: Record<
  GitStatusEvent,
  CloudIssue["state"] | null
> = {
  draft: "active",
  open: "review",
  approved: null,
  merged: "complete",
};

export const automationStatusCategories = [
  "backlog",
  "ready",
  "active",
  "review",
  "complete",
] as const satisfies readonly CloudIssue["state"][];

export function pullRequestAutomationEvent(
  pullRequest: Pick<PullRequestSignals, "state" | "draft" | "review">,
  closes: boolean,
): GitStatusEvent | null {
  if (pullRequest.state === "merged") return closes ? "merged" : null;
  if (pullRequest.state === "closed") return null;
  if (pullRequest.draft) return "draft";
  return pullRequest.review === "approved" ? "approved" : "open";
}

export interface AutomationStatus {
  id: string;
  category: CloudIssue["state"];
  position: number;
  archived: boolean;
}

const progress: Partial<Record<CloudIssue["state"], number>> = {
  triage: 0,
  backlog: 1,
  ready: 2,
  active: 3,
  review: 4,
  complete: 5,
};

function rank(status: AutomationStatus): [number, number] | null {
  const category = progress[status.category];
  return category === undefined ? null : [category, status.position];
}

export function automationStatus(
  event: GitStatusEvent,
  rule: string | null | undefined,
  statuses: readonly AutomationStatus[],
): AutomationStatus | null {
  if (rule === null) return null;
  if (rule !== undefined)
    return (
      statuses.find(
        (status) =>
          status.id === rule &&
          !status.archived &&
          (automationStatusCategories as readonly string[]).includes(
            status.category,
          ),
      ) ?? null
    );
  const category = defaultAutomationCategories[event];
  return (
    [...statuses]
      .sort((left, right) => left.position - right.position)
      .find((status) => status.category === category && !status.archived) ??
    null
  );
}

export function automationTarget(
  event: GitStatusEvent,
  rule: string | null | undefined,
  statuses: readonly AutomationStatus[],
  current: AutomationStatus,
): AutomationStatus | null {
  const target = automationStatus(event, rule, statuses);
  const from = rank(current);
  const to = target && rank(target);
  if (!target || !from || !to || target.id === current.id) return null;
  return to[0] > from[0] || (to[0] === from[0] && to[1] > from[1])
    ? target
    : null;
}

export function reviewDecision(
  latestStates: readonly string[],
): GitReviewDecision {
  if (latestStates.includes("CHANGES_REQUESTED")) return "changes_requested";
  return latestStates.includes("APPROVED") ? "approved" : "none";
}

export type CheckRunState = "success" | "failure" | "pending" | "skipped";

const failedConclusions = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

export function checkRunState(
  status: string,
  conclusion: string | null,
): CheckRunState {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "success";
  return failedConclusions.has(conclusion ?? "") ? "failure" : "skipped";
}

export function checksState(runs: readonly CheckRunState[]): GitChecksState {
  if (!runs.length) return "none";
  if (runs.includes("failure")) return "failure";
  return runs.includes("pending") ? "pending" : "success";
}

export type AttentionReason = "conflicts" | "checks" | "changes";

export function attentionReasons(
  pullRequest: PullRequestSignals,
): AttentionReason[] {
  if (pullRequestStage(pullRequest) !== "attention") return [];
  return [
    pullRequest.mergeableState === "dirty" && ("conflicts" as const),
    pullRequest.checks === "failure" && ("checks" as const),
    pullRequest.review === "changes_requested" && ("changes" as const),
  ].filter((reason) => reason !== false);
}
