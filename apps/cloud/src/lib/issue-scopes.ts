import {
  cloudId,
  issuePriorities,
  issueSorts,
  type CloudIssue,
  type IssueFilters,
  type IssueSort,
} from "./cloud-contract";

type ScopeDefinition = {
  label: string;
  states: CloudIssue["state"][] | undefined;
  assignedToActor: boolean;
};

export const issueScopes = {
  all: { label: "All issues", states: undefined, assignedToActor: false },
  active: {
    label: "Active",
    states: ["ready", "active", "blocked", "review"],
    assignedToActor: false,
  },
  backlog: { label: "Backlog", states: ["backlog"], assignedToActor: false },
  mine: {
    label: "My issues",
    states: ["backlog", "ready", "active", "blocked", "review"],
    assignedToActor: true,
  },
} satisfies Record<string, ScopeDefinition>;

export type IssueScope = keyof typeof issueScopes;

export function parseIssueScope(value: unknown): IssueScope {
  return typeof value === "string" && Object.hasOwn(issueScopes, value)
    ? (value as IssueScope)
    : "all";
}

export const unassignedFilter = "none";
export const unestimatedFilter = "none";

export function parseIssueSort(value: unknown): IssueSort {
  return issueSorts.find((sort) => sort === value) ?? "updated";
}

export function issueFiltersFromParameters(
  params: Record<string, string | string[] | undefined>,
): IssueFilters {
  const scope = issueScopes[parseIssueScope(params.scope)];
  return {
    states: scope.states,
    assignedToActor: scope.assignedToActor,
    teamId: cloudId.safeParse(params.teamId).data,
    projectId: cloudId.safeParse(params.projectId).data,
    cycleId: cloudId.safeParse(params.cycleId).data,
    labelId: cloudId.safeParse(params.labelId).data,
    statusId: cloudId.safeParse(params.statusId).data,
    assigneeId: cloudId.safeParse(params.assigneeId).data,
    unassigned: params.assigneeId === unassignedFilter,
    priority: issuePriorities.find((priority) => priority === params.priority),
    unestimated: params.estimate === unestimatedFilter,
    query:
      typeof params.query === "string" ? params.query.slice(0, 200) : undefined,
    archived: params.archived === "true",
    sort: parseIssueSort(params.sort),
    offset: Math.min(
      1_000_000,
      Math.max(0, Number.parseInt(String(params.offset ?? "0"), 10) || 0),
    ),
  };
}
