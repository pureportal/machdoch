import type { CloudIssueSummary } from "./cloud-contract";

export const issueDensities = {
  comfortable: "Comfortable",
  compact: "Compact",
} as const;
export type IssueDensity = keyof typeof issueDensities;

export const completedWindows = {
  all: "All",
  week: "Past week",
  month: "Past month",
  none: "None",
} as const;
export type CompletedWindow = keyof typeof completedWindows;

const windowDays: Record<"week" | "month", number> = { week: 7, month: 30 };
const dayMs = 86_400_000;

export interface IssueViewOptions {
  board: boolean;
  density: IssueDensity;
  completed: CompletedWindow;
  subIssues: boolean;
  emptyGroups: boolean;
}

function oneOf<T extends string>(
  options: Record<T, string>,
  value: string | null,
  fallback: T,
): T {
  return value && Object.hasOwn(options, value) ? (value as T) : fallback;
}

export function parseIssueViewOptions(
  search: Pick<URLSearchParams, "get">,
): IssueViewOptions {
  return {
    board: search.get("view") === "board",
    density: oneOf(issueDensities, search.get("density"), "comfortable"),
    completed: oneOf(completedWindows, search.get("completed"), "all"),
    subIssues: search.get("subIssues") !== "hide",
    emptyGroups: search.get("empty") === "show",
  };
}

export function visibleIssues<
  Issue extends Pick<CloudIssueSummary, "state" | "updatedAt" | "parent">,
>(issues: Issue[], options: IssueViewOptions, now = Date.now()): Issue[] {
  return issues.filter((issue) => {
    if (!options.subIssues && issue.parent) return false;
    if (issue.state !== "complete" && issue.state !== "canceled") return true;
    if (options.completed === "all") return true;
    if (options.completed === "none") return false;
    return (
      now - Date.parse(issue.updatedAt) <= windowDays[options.completed] * dayMs
    );
  });
}
