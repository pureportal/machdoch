import type {
  LoopMissedPolicy,
  LoopOverlapPolicy,
} from "./cloud-loop-contract";

export interface LoopAdmissionInput {
  automationId: string;
  dryRun: boolean;
  loopsEnabled: boolean;
  killed: boolean;
  chainAutomationIds: readonly string[];
  dailyUsed: number;
  dailyLimit: number;
  overlap: LoopOverlapPolicy;
  activeRuns: number;
  runBudgetCents: number | null;
  runBudgetCapCents: number | null;
  monthBudgetCents: number | null;
  monthBudgetCapCents: number | null;
  loopMonthCents: number;
  workspaceMonthCents: number;
}

export type LoopRejectionCode =
  | "loops_disabled"
  | "killed"
  | "chain_loop"
  | "daily_limit"
  | "overlap"
  | "month_budget"
  | "capability"
  | "unavailable";

export interface LoopRejection {
  code: LoopRejectionCode;
  reason: string;
}

export type LoopAdmission =
  | { admitted: true; reservedCents: number; cancelActive: boolean }
  | ({ admitted: false } & LoopRejection);

function tightest(...limits: (number | null)[]): number | null {
  const set = limits.filter((limit): limit is number => limit !== null);
  return set.length ? Math.min(...set) : null;
}

export function runBudgetCents(
  input: Pick<LoopAdmissionInput, "runBudgetCents" | "runBudgetCapCents">,
): number | null {
  return tightest(input.runBudgetCents, input.runBudgetCapCents);
}

function exceedsMonthBudget(
  committedCents: number,
  reservedCents: number,
  budgetCents: number | null,
): boolean {
  return (
    budgetCents !== null &&
    (committedCents >= budgetCents ||
      committedCents + reservedCents > budgetCents)
  );
}

export function admitLoopRun(input: LoopAdmissionInput): LoopAdmission {
  if (!input.loopsEnabled)
    return {
      admitted: false,
      code: "loops_disabled",
      reason: "Automations are turned off.",
    };
  if (input.killed)
    return {
      admitted: false,
      code: "killed",
      reason: "The automation was stopped.",
    };
  if (input.chainAutomationIds.includes(input.automationId))
    return {
      admitted: false,
      code: "chain_loop",
      reason: "This automation already ran earlier in the same chain.",
    };
  if (input.dryRun)
    return { admitted: true, reservedCents: 0, cancelActive: false };
  if (input.dailyUsed >= input.dailyLimit)
    return {
      admitted: false,
      code: "daily_limit",
      reason: "The daily run limit was reached.",
    };
  if (input.overlap === "skip" && input.activeRuns > 0)
    return {
      admitted: false,
      code: "overlap",
      reason: "The previous run is still active.",
    };
  const reservedCents = runBudgetCents(input) ?? 0;
  if (
    exceedsMonthBudget(
      input.loopMonthCents,
      reservedCents,
      input.monthBudgetCents,
    ) ||
    exceedsMonthBudget(
      input.workspaceMonthCents,
      reservedCents,
      input.monthBudgetCapCents,
    )
  )
    return {
      admitted: false,
      code: "month_budget",
      reason: "The monthly budget is used up.",
    };
  return {
    admitted: true,
    reservedCents,
    cancelActive: input.overlap === "cancel_previous" && input.activeRuns > 0,
  };
}

export function loopCostCents(
  tokens: number,
  centsPerThousandTokens: number,
): number {
  return Math.ceil((tokens * centsPerThousandTokens) / 1000);
}

export function exceedsRunBudget(
  costCents: number,
  budgetCents: number | null,
): boolean {
  return budgetCents !== null && costCents > budgetCents;
}

export function shouldPauseLoop(
  consecutiveFailures: number,
  pauseAfterFailures: number | null,
): boolean {
  return (
    pauseAfterFailures !== null && consecutiveFailures >= pauseAfterFailures
  );
}

export const missedRunGraceMs = 5 * 60_000;

export function missedRunsToStart(
  policy: LoopMissedPolicy,
  dueAt: Date,
  now: Date,
  graceMs: number,
): number {
  if (now.getTime() < dueAt.getTime()) return 0;
  if (policy === "skip" && now.getTime() - dueAt.getTime() > graceMs) return 0;
  return 1;
}

export const consequentialActionKinds = new Set<string>([
  "set_status",
  "set_priority",
  "assign",
  "add_labels",
  "remove_labels",
  "comment",
  "create_issue",
  "delegate",
  "git_comment",
  "git_review",
  "git_merge",
  "git_update_branch",
  "git_retarget",
  "send_webhook",
  "write_release_posts",
  "prepare_release",
  "write_project_updates",
  "append_document_section",
  "notify",
  "fan_out",
]);
