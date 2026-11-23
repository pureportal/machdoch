import type { CloudLoopSummary } from "./cloud-loop-contract";
import type {
  IssueFilterCondition,
  IssueFilterField,
} from "./issue-filter-model";
import { meFilterValue } from "./issue-filter-model";

export type LoopScope = "mine" | "all";

export const loopFilterFields = [
  "team",
  "creator",
  "updated",
  "automated",
] as const satisfies readonly IssueFilterField[];

export interface LoopListTeam {
  id: string;
  name: string;
  parentId: string | null;
}

export interface LoopListQuery {
  scope: LoopScope;
  userId: string;
  search: string;
  conditions: readonly IssueFilterCondition[];
  now: Date;
}

export interface LoopTeamGroup {
  team: LoopListTeam;
  path: string;
  loops: CloudLoopSummary[];
}

const dayMs = 86_400_000;
const relativeDays: Record<string, number> = { day: 1, week: 7, month: 30 };

export function loopSuccessRate(loop: CloudLoopSummary): number | null {
  return loop.finishedRuns
    ? Math.round((loop.succeededRuns / loop.finishedRuns) * 100)
    : null;
}

function matchesDate(
  value: string | null,
  condition: IssueFilterCondition,
  now: Date,
): boolean {
  if (condition.operator === "empty") return value === null;
  if (value === null) return false;
  const time = new Date(value).getTime();
  const [first] = condition.values;
  if (condition.operator === "before")
    return time < new Date(`${first}T00:00:00Z`).getTime();
  if (condition.operator === "after")
    return time >= new Date(`${first}T00:00:00Z`).getTime() + dayMs;
  const days =
    condition.operator === "within"
      ? Number(first)
      : Math.max(...condition.values.map((v) => relativeDays[v] ?? 0));
  return time >= now.getTime() - days * dayMs;
}

function matchesCondition(
  loop: CloudLoopSummary,
  condition: IssueFilterCondition,
  userId: string,
  now: Date,
): boolean {
  switch (condition.field) {
    case "team":
      return condition.values.includes(loop.teamId);
    case "creator":
      return condition.values.some(
        (value) => (value === meFilterValue ? userId : value) === loop.ownerId,
      );
    case "updated":
      return matchesDate(loop.lastRunAt, condition, now);
    case "automated":
      return loop.enabled && !loop.killed;
    default:
      return true;
  }
}

export function loopMatches(
  loop: CloudLoopSummary,
  query: LoopListQuery,
): boolean {
  if (query.scope === "mine" && loop.ownerId !== query.userId) return false;
  const search = query.search.trim().toLowerCase();
  if (
    search &&
    !`${loop.name}\n${loop.description}\n${loop.trigger}`
      .toLowerCase()
      .includes(search)
  )
    return false;
  return query.conditions.every(
    (condition) =>
      matchesCondition(loop, condition, query.userId, query.now) !==
      condition.negated,
  );
}

export function groupLoopsByTeam(
  loops: readonly CloudLoopSummary[],
  teams: readonly LoopListTeam[],
  query: LoopListQuery,
): LoopTeamGroup[] {
  const known = new Set(teams.map((team) => team.id));
  const groups: LoopTeamGroup[] = [];
  const visit = (
    parentId: string | null,
    prefix: string,
    seen: ReadonlySet<string>,
  ) => {
    for (const team of teams
      .filter(
        (candidate) =>
          !seen.has(candidate.id) &&
          (parentId === null
            ? candidate.parentId === null || !known.has(candidate.parentId)
            : candidate.parentId === parentId),
      )
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix} › ${team.name}` : team.name;
      groups.push({
        team,
        path,
        loops: loops
          .filter((loop) => loop.teamId === team.id && loopMatches(loop, query))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
      visit(team.id, path, new Set([...seen, team.id]));
    }
  };
  visit(null, "", new Set());
  return groups;
}
