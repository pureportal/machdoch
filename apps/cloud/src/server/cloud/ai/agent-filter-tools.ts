import { z } from "zod";
import {
  aiFilterValue,
  encodeIssueFilter,
  issueFilterConditionSchema,
  issueFilterFields,
  issueFilterOperators,
  meFilterValue,
  noneFilterValue,
  relativeCycleValues,
  type IssueFilterCondition,
  type IssueFilterField,
} from "../../../lib/issue-filter-model";
import type { AgentActionField } from "../../../lib/cloud-chat-contract";
import { agentTool, type AgentTool } from "./agent-tool";
import { pendingOutput, reference } from "./agent-proposal-helpers";
import { AgentLookupError } from "./agent-workspace";
import type { CloudAgentSession } from "./agent-tools";

const proposedCondition = z.strictObject({
  field: z.enum(issueFilterFields),
  negated: z
    .boolean()
    .optional()
    .describe("True for is not, none of, or do not include."),
  operator: z
    .enum(issueFilterOperators)
    .optional()
    .describe(
      "all: labels include all of. empty: the field is empty (no values). before/after: one YYYY-MM-DD date. within: one number of days.",
    ),
  values: z
    .array(reference)
    .max(50)
    .optional()
    .describe(
      "Names as shown in the workspace: status, label, project, cycle, team, milestone and initiative names; member names or me; none for unset; ai for agent assignee or delegate; current, upcoming or previous for cycles; breached, at_risk, ok or none for SLA; yes for flags such as blocked.",
    ),
});
type ProposedCondition = z.infer<typeof proposedCondition>;

interface NamedOption {
  id: string;
  name: string;
}

type FilterCatalog = Partial<Record<IssueFilterField, NamedOption[]>>;

const keptValues: Partial<Record<IssueFilterField, readonly string[]>> = {
  assignee: [meFilterValue, noneFilterValue, aiFilterValue],
  delegate: [meFilterValue, noneFilterValue, aiFilterValue],
  creator: [meFilterValue],
  label: [noneFilterValue],
  project: [noneFilterValue],
  milestone: [noneFilterValue],
  initiative: [noneFilterValue],
  releasedIn: [noneFilterValue],
  cycle: [noneFilterValue, ...relativeCycleValues],
};

const fieldNames: Record<IssueFilterField, string> = {
  status: "Status",
  assignee: "Assignee",
  creator: "Creator",
  priority: "Priority",
  label: "Labels",
  project: "Project",
  cycle: "Cycle",
  estimate: "Estimate",
  due: "Due date",
  created: "Created",
  updated: "Updated",
  pullRequest: "Pull request",
  team: "Team",
  milestone: "Milestone",
  initiative: "Initiative",
  delegate: "Agent",
  blocked: "Blocked",
  blocking: "Blocking",
  hasParent: "Has parent",
  hasSubIssues: "Has sub-issues",
  duplicate: "Duplicate",
  automated: "Created by agent or automation",
  releasedIn: "Released in",
  sla: "SLA",
};

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function resolveValues(
  field: IssueFilterField,
  values: string[],
  catalog: FilterCatalog,
): { ids: string[]; names: string[] } {
  const options = catalog[field];
  if (!options) {
    const ids = field === "estimate" ? values : values.map(normalized);
    return { ids, names: ids };
  }
  const ids: string[] = [];
  const names: string[] = [];
  for (const value of values) {
    const key = normalized(value);
    if (keptValues[field]?.includes(key)) {
      ids.push(key);
      names.push(key);
      continue;
    }
    const exact = options.filter(
      (option) => option.id === value || normalized(option.name) === key,
    );
    const matches = exact.length
      ? exact
      : options.filter((option) => normalized(option.name).includes(key));
    if (!matches.length)
      throw new AgentLookupError(
        `${fieldNames[field]}: nothing matches "${value}".`,
      );
    if (!exact.length && new Set(matches.map((match) => match.name)).size > 1)
      throw new AgentLookupError(
        `"${value}" matches several: ${[...new Set(matches.map((match) => match.name))].join(", ")}.`,
      );
    ids.push(...matches.map((match) => match.id));
    names.push(matches[0]!.name);
  }
  return { ids: [...new Set(ids)], names: [...new Set(names)] };
}

function describe(condition: IssueFilterCondition, names: string[]): string {
  const { field, negated, operator } = condition;
  if (operator === "empty") return negated ? "is not empty" : "is empty";
  if (operator === "before" || operator === "after")
    return `${operator} ${names[0]}`;
  if (operator === "within") return `within last ${names[0]} days`;
  if (field === "label")
    return `${negated ? "do not include" : operator === "all" ? "include all of" : "include any of"} ${names.join(", ")}`;
  return `${negated ? (names.length > 1 ? "is none of" : "is not") : names.length > 1 ? "is any of" : "is"} ${names.join(", ")}`;
}

export function resolveProposedFilter(
  proposed: ProposedCondition,
  catalog: FilterCatalog,
): { condition: IssueFilterCondition; field: AgentActionField } {
  const operator = proposed.operator;
  const raw = proposed.values ?? [];
  const resolved =
    operator && operator !== "all"
      ? { ids: raw, names: raw }
      : resolveValues(proposed.field, raw, catalog);
  const parsed = issueFilterConditionSchema.safeParse({
    field: proposed.field,
    negated: proposed.negated ?? false,
    ...(operator ? { operator } : {}),
    values: resolved.ids,
  });
  if (!parsed.success)
    throw new AgentLookupError(
      `${fieldNames[proposed.field]}: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
    );
  return {
    condition: parsed.data,
    field: {
      label: fieldNames[proposed.field],
      value: describe(parsed.data, resolved.names),
    },
  };
}

async function filterCatalog(
  session: CloudAgentSession,
): Promise<FilterCatalog> {
  const { workspace, services, actor } = session;
  const { snapshot } = workspace;
  const [labels, milestones, initiatives] = await Promise.all([
    services.labels.listVisible(actor),
    services.milestones.list(actor),
    services.initiatives.list(actor),
  ]);
  const members = snapshot.members.map(({ id, name }) => ({ id, name }));
  return {
    status: snapshot.workflows.flatMap((workflow) =>
      workflow.statuses
        .filter((status) => !status.archived)
        .flatMap((status) => [
          { id: status.id, name: status.name },
          { id: status.id, name: status.category },
        ]),
    ),
    label: labels
      .filter((label) => !label.archived)
      .map(({ id, name }) => ({ id, name })),
    project: snapshot.projects.map(({ id, name }) => ({ id, name })),
    cycle: snapshot.cycles.map(({ id, name }) => ({ id, name })),
    team: snapshot.teams.flatMap(({ id, name, key }) => [
      { id, name },
      { id, name: key },
    ]),
    milestone: milestones.map(({ id, name }) => ({ id, name })),
    initiative: initiatives.map(({ id, name }) => ({ id, name })),
    assignee: members,
    creator: members,
    delegate: members,
  };
}

export const filterTools: AgentTool[] = [
  agentTool({
    name: "propose_issue_filter",
    description:
      "Turn a description of issues into filter chips the user opens and edits on the issue list. Top-level conditions must all match; each anyOf group matches when one of its conditions does. Nothing runs until the user opens it.",
    schema: z.strictObject({
      conditions: z.array(proposedCondition).max(20),
      anyOf: z
        .array(z.array(proposedCondition).min(2).max(10))
        .max(5)
        .optional(),
    }),
    async run(session, input) {
      if (!input.conditions.length && !input.anyOf?.length)
        throw new AgentLookupError("Add at least one condition.");
      const catalog = await filterCatalog(session);
      const conditions = input.conditions.map((condition) =>
        resolveProposedFilter(condition, catalog),
      );
      const groups = (input.anyOf ?? []).map((group) =>
        group.map((condition) => resolveProposedFilter(condition, catalog)),
      );
      const filter = encodeIssueFilter({
        conditions: conditions.map((entry) => entry.condition),
        groups: groups.map((group) => group.map((entry) => entry.condition)),
      });
      return {
        output: pendingOutput,
        label: "Proposed an issue filter",
        proposal: {
          kind: "issue_filter",
          title: "Issue filter",
          fields: [
            ...conditions.map((entry) => entry.field),
            ...groups.map((group) => ({
              label: "Any of",
              value: group
                .map((entry) => `${entry.field.label} ${entry.field.value}`)
                .join(" or "),
            })),
          ],
          filter,
        },
      };
    },
  }),
];
