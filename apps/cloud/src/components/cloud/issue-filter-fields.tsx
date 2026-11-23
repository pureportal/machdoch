import {
  Ban,
  Bot,
  CalendarClock,
  CalendarPlus,
  CircleDashed,
  CircleSlash,
  Copy,
  FolderKanban,
  Gauge,
  GitPullRequest,
  History,
  ListTree,
  Milestone,
  Network,
  OctagonAlert,
  Signal,
  Tag,
  Target,
  Timer,
  UserRound,
  UserRoundPen,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import { pullRequestStages } from "@/lib/git-automation";
import {
  isFlagFilterField,
  type IssueFilterOperatorChoice,
} from "@/lib/issue-filter-editing";
import {
  aiFilterValue,
  flagFilterValue,
  meFilterValue,
  noneFilterValue,
  type IssueFilterCondition,
  type IssueFilterField,
} from "@/lib/issue-filter-model";
import {
  assigneeOptions,
  cycleOptions,
  priorityOptions,
  projectOptions,
  StateIcon,
} from "./issue-properties";
import { labelColors } from "./label-chip";
import { PersonAvatar } from "./person-avatar";
import {
  PullRequestStageIcon,
  pullRequestStageLabels,
} from "./pull-request-state";
import type { PropertyOption } from "./property-menu";

export interface FilterFieldDefinition {
  field: IssueFilterField;
  label: string;
  icon: LucideIcon;
  options: PropertyOption[];
}

const me = {
  value: meFilterValue,
  label: "Me",
  icon: <UserRound size={14} aria-hidden="true" />,
};
const none = (label: string) => ({
  value: noneFilterValue,
  label,
  icon: <CircleSlash size={14} aria-hidden="true" />,
});

export interface FilterReferences {
  initiatives: { id: string; name: string }[];
  milestones: { id: string; name: string }[];
}

const flag = [{ value: flagFilterValue, label: "Yes" }];

export function filterFieldDefinitions(
  workspace: CloudWorkspace,
  labels: CloudLabel[],
  teamId: string | null,
  references: FilterReferences = { initiatives: [], milestones: [] },
): FilterFieldDefinition[] {
  const scope = teamId ?? undefined;
  const multipleTeams = !teamId && workspace.teams.length > 1;
  const teamKey = (id: string) =>
    multipleTeams
      ? ` · ${workspace.teams.find((team) => team.id === id)?.key ?? ""}`
      : "";
  const members = workspace.members.map((member) => ({
    value: member.id,
    label: member.name,
    icon: <PersonAvatar name={member.name} className="cloud-avatar-small" />,
  }));
  return [
    {
      field: "status",
      label: "Status",
      icon: CircleDashed,
      options: workspace.workflows
        .filter((workflow) => !teamId || workflow.teamId === teamId)
        .flatMap((workflow) =>
          workflow.statuses
            .filter((status) => !status.archived)
            .map((status) => ({
              value: status.id,
              label: `${status.name}${teamKey(workflow.teamId)}`,
              icon: <StateIcon state={status.category} />,
            })),
        ),
    },
    {
      field: "assignee",
      label: "Assignee",
      icon: UserRound,
      options: [
        me,
        none("No assignee"),
        ...assigneeOptions(workspace).slice(1),
      ],
    },
    {
      field: "creator",
      label: "Creator",
      icon: UserRoundPen,
      options: [me, ...members],
    },
    {
      field: "priority",
      label: "Priority",
      icon: Signal,
      options: priorityOptions,
    },
    {
      field: "label",
      label: "Labels",
      icon: Tag,
      options: [
        none("No labels"),
        ...labels
          .filter((label) => !label.archived)
          .map((label) => ({
            value: label.id,
            label: `${label.name}${teamKey(label.teamId)}`,
            icon: (
              <span
                className="cloud-filter-label-dot"
                style={{ backgroundColor: labelColors[label.color] }}
                aria-hidden="true"
              />
            ),
          })),
      ],
    },
    {
      field: "project",
      label: "Project",
      icon: FolderKanban,
      options: projectOptions(workspace, scope).map((option, index) =>
        index ? option : { ...option, value: noneFilterValue },
      ),
    },
    {
      field: "cycle",
      label: "Cycle",
      icon: Timer,
      options: [
        { value: "current", label: "Current cycle" },
        { value: "upcoming", label: "Upcoming cycle" },
        { value: "previous", label: "Previous cycle" },
        ...cycleOptions(workspace, scope).map((option, index) =>
          index ? option : { ...option, value: noneFilterValue },
        ),
      ],
    },
    {
      field: "estimate",
      label: "Estimate",
      icon: Gauge,
      options: [
        { value: "none", label: "Not estimated" },
        { value: "set", label: "Estimated" },
        ...[
          ...new Set(
            workspace.teams
              .filter((team) => !teamId || team.id === teamId)
              .flatMap((team) => team.estimateScale.map((card) => card.label)),
          ),
        ].map((label) => ({ value: label, label })),
      ],
    },
    {
      field: "due",
      label: "Due date",
      icon: CalendarClock,
      options: [
        { value: "overdue", label: "Overdue" },
        { value: "week", label: "Due within a week" },
        { value: "month", label: "Due within a month" },
        { value: "none", label: "No due date" },
      ],
    },
    {
      field: "created",
      label: "Created",
      icon: CalendarPlus,
      options: [
        { value: "day", label: "Past day" },
        { value: "week", label: "Past week" },
        { value: "month", label: "Past month" },
      ],
    },
    {
      field: "updated",
      label: "Updated",
      icon: History,
      options: [
        { value: "day", label: "Past day" },
        { value: "week", label: "Past week" },
        { value: "month", label: "Past month" },
      ],
    },
    {
      field: "pullRequest",
      label: "Pull request",
      icon: GitPullRequest,
      options: [
        ...pullRequestStages.map((stage) => ({
          value: stage,
          label: pullRequestStageLabels[stage],
          icon: <PullRequestStageIcon stage={stage} label="" />,
        })),
        none("No pull request"),
      ],
    },
    {
      field: "team",
      label: "Team",
      icon: Users,
      options: workspace.teams.map((team) => ({
        value: team.id,
        label: team.name,
      })),
    },
    {
      field: "milestone",
      label: "Milestone",
      icon: Milestone,
      options: [
        none("No milestone"),
        ...references.milestones.map((milestone) => ({
          value: milestone.id,
          label: milestone.name,
        })),
      ],
    },
    {
      field: "initiative",
      label: "Initiative",
      icon: Target,
      options: [
        none("No initiative"),
        ...references.initiatives.map((initiative) => ({
          value: initiative.id,
          label: initiative.name,
        })),
      ],
    },
    {
      field: "delegate",
      label: "Agent delegate",
      icon: Bot,
      options: [
        {
          value: aiFilterValue,
          label: "Delegated to agent",
          icon: <Bot size={14} aria-hidden="true" />,
        },
        none("Not delegated"),
        me,
        ...members,
      ],
    },
    { field: "blocked", label: "Blocked", icon: Ban, options: flag },
    { field: "blocking", label: "Blocking", icon: OctagonAlert, options: flag },
    { field: "hasParent", label: "Has parent", icon: Network, options: flag },
    {
      field: "hasSubIssues",
      label: "Has sub-issues",
      icon: ListTree,
      options: flag,
    },
    { field: "duplicate", label: "Duplicate", icon: Copy, options: flag },
    {
      field: "automated",
      label: "Created by agent or loop",
      icon: Workflow,
      options: flag,
    },
  ];
}

const dateFields: readonly IssueFilterField[] = ["due", "created", "updated"];

export function operatorLabel(
  field: IssueFilterField,
  choice: IssueFilterOperatorChoice,
  multiple: boolean,
): string {
  if (isFlagFilterField(field)) return choice.negated ? "no" : "yes";
  switch (choice.operator) {
    case "all":
      return "include all of";
    case "empty":
      return choice.negated ? "is not empty" : "is empty";
    case "before":
      return "before";
    case "after":
      return "after";
    case "within":
      return field === "due" ? "within next days" : "within last days";
  }
  if (field === "label")
    return choice.negated ? "do not include" : "include any of";
  if (choice.negated) return multiple ? "is none of" : "is not";
  return multiple ? "is any of" : "is";
}

export function conditionOperator(condition: IssueFilterCondition): string {
  return operatorLabel(condition.field, condition, condition.values.length > 1);
}

export function isDateOperator(condition: IssueFilterCondition): boolean {
  return (
    dateFields.includes(condition.field) &&
    (condition.operator === "before" ||
      condition.operator === "after" ||
      condition.operator === "within")
  );
}

export function conditionValues(
  condition: IssueFilterCondition,
  definition: FilterFieldDefinition | undefined,
): string {
  if (condition.operator === "empty" || isFlagFilterField(condition.field))
    return "";
  if (isDateOperator(condition)) return condition.values[0] ?? "";
  const names = condition.values.map(
    (value) =>
      definition?.options.find((option) => option.value === value)?.label ??
      "Unavailable",
  );
  return names.length > 2
    ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
    : names.join(", ");
}

export function describeCondition(
  condition: IssueFilterCondition,
  definitions: FilterFieldDefinition[],
): string {
  const definition = definitions.find(
    (entry) => entry.field === condition.field,
  );
  return [
    definition?.label ?? condition.field,
    conditionOperator(condition),
    conditionValues(condition, definition),
  ]
    .filter(Boolean)
    .join(" ");
}
