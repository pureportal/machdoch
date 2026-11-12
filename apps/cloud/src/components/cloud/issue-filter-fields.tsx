import {
  CalendarClock,
  CalendarPlus,
  CircleDashed,
  CircleSlash,
  FolderKanban,
  Gauge,
  GitPullRequest,
  Signal,
  Tag,
  Timer,
  UserRound,
  UserRoundPen,
  type LucideIcon,
} from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import { pullRequestStages } from "@/lib/github-automation";
import {
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

export function filterFieldDefinitions(
  workspace: CloudWorkspace,
  labels: CloudLabel[],
  teamId: string | null,
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
      options: cycleOptions(workspace, scope).map((option, index) =>
        index ? option : { ...option, value: noneFilterValue },
      ),
    },
    {
      field: "estimate",
      label: "Estimate",
      icon: Gauge,
      options: [
        { value: "none", label: "Not estimated" },
        { value: "set", label: "Estimated" },
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
  ];
}

export function conditionOperator(condition: IssueFilterCondition): string {
  const multiple = condition.values.length > 1;
  if (condition.negated) return multiple ? "is none of" : "is not";
  return multiple ? "is any of" : "is";
}

export function conditionValues(
  condition: IssueFilterCondition,
  definition: FilterFieldDefinition | undefined,
): string {
  const names = condition.values.map(
    (value) =>
      definition?.options.find((option) => option.value === value)?.label ??
      "Unavailable",
  );
  return names.length > 2
    ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
    : names.join(", ");
}
