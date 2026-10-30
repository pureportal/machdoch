import type { CloudIssue } from "./cloud-contract";

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
