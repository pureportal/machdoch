import {
  Activity,
  ArrowRightLeft,
  Play,
  Power,
  Workflow,
  Bot,
  CalendarClock,
  CirclePlus,
  CircleDashed,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  MessageSquareCode,
  UserRoundCheck,
  Waypoints,
  Hand,
  Laptop,
  Megaphone,
  MessageSquare,
  MessageSquarePlus,
  Rocket,
  Send,
  Signal,
  Sparkles,
  SquarePlus,
  Tag,
  Tags,
  UserRound,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  AutomationAction,
  AutomationActionKind,
  AutomationOutcome,
  AutomationTrigger,
  AutomationTriggerKind,
} from "@/lib/cloud-automation-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import {
  channelKindLabels,
  type CloudProduct,
} from "@/lib/cloud-release-contract";
import type { GitEventKind } from "@/lib/git-events";
import { pullRequestStageLabels } from "./pull-request-state";
import { priorityNames } from "./issue-properties";

export const triggerKinds: {
  kind: AutomationTriggerKind;
  label: string;
  icon: LucideIcon;
  group: string;
}[] = [
  {
    kind: "issue_created",
    label: "Issue is created",
    icon: CirclePlus,
    group: "Issues",
  },
  {
    kind: "status_changed",
    label: "Status changes",
    icon: CircleDashed,
    group: "Issues",
  },
  {
    kind: "priority_changed",
    label: "Priority changes",
    icon: Signal,
    group: "Issues",
  },
  {
    kind: "assignee_changed",
    label: "Assignee changes",
    icon: UserRound,
    group: "Issues",
  },
  { kind: "label_added", label: "Label is added", icon: Tag, group: "Issues" },
  {
    kind: "comment_created",
    label: "Comment is added",
    icon: MessageSquare,
    group: "Issues",
  },
  {
    kind: "pull_request_changed",
    label: "Linked pull request changes",
    icon: GitPullRequest,
    group: "Repositories",
  },
  {
    kind: "git_event",
    label: "Repository event",
    icon: GitBranch,
    group: "Repositories",
  },
  {
    kind: "release_created",
    label: "Release is created",
    icon: Rocket,
    group: "Releases",
  },
  {
    kind: "automation_finished",
    label: "Another automation finishes",
    icon: Workflow,
    group: "Automations",
  },
  {
    kind: "schedule",
    label: "On a schedule",
    icon: CalendarClock,
    group: "Other",
  },
  {
    kind: "webhook",
    label: "Webhook is called",
    icon: Webhook,
    group: "Other",
  },
  { kind: "manual", label: "Run manually", icon: Hand, group: "Other" },
];

export const actionKinds: {
  kind: AutomationActionKind;
  label: string;
  icon: LucideIcon;
  group: string;
  issue: boolean;
}[] = [
  {
    kind: "ask_agent",
    label: "Ask Agent",
    icon: Sparkles,
    group: "AI",
    issue: false,
  },
  {
    kind: "delegate",
    label: "Start AI task",
    icon: Bot,
    group: "AI",
    issue: false,
  },
  {
    kind: "set_status",
    label: "Set status",
    icon: ArrowRightLeft,
    group: "Issue",
    issue: true,
  },
  {
    kind: "set_priority",
    label: "Set priority",
    icon: Signal,
    group: "Issue",
    issue: true,
  },
  {
    kind: "assign",
    label: "Assign",
    icon: UserRound,
    group: "Issue",
    issue: true,
  },
  {
    kind: "add_labels",
    label: "Add labels",
    icon: Tags,
    group: "Issue",
    issue: true,
  },
  {
    kind: "remove_labels",
    label: "Remove labels",
    icon: X,
    group: "Issue",
    issue: true,
  },
  {
    kind: "comment",
    label: "Add comment",
    icon: MessageSquarePlus,
    group: "Issue",
    issue: true,
  },
  {
    kind: "create_issue",
    label: "Create issue",
    icon: SquarePlus,
    group: "Issue",
    issue: false,
  },
  {
    kind: "prepare_release",
    label: "Prepare release",
    icon: Rocket,
    group: "AI",
    issue: false,
  },
  {
    kind: "write_release_posts",
    label: "Write channel posts",
    icon: Megaphone,
    group: "AI",
    issue: false,
  },
  {
    kind: "start_client_session",
    label: "Start on client",
    icon: Laptop,
    group: "AI",
    issue: false,
  },
  {
    kind: "git_comment",
    label: "Comment on pull request",
    icon: MessageSquareCode,
    group: "Pull request",
    issue: false,
  },
  {
    kind: "git_review",
    label: "Review pull request",
    icon: UserRoundCheck,
    group: "Pull request",
    issue: false,
  },
  {
    kind: "git_merge",
    label: "Merge pull request",
    icon: GitMerge,
    group: "Pull request",
    issue: false,
  },
  {
    kind: "git_update_branch",
    label: "Update branch",
    icon: GitPullRequestArrow,
    group: "Pull request",
    issue: false,
  },
  {
    kind: "git_retarget",
    label: "Retarget stacked pull request",
    icon: Waypoints,
    group: "Pull request",
    issue: false,
  },
  {
    kind: "write_project_updates",
    label: "Write project updates",
    icon: Activity,
    group: "AI",
    issue: false,
  },
  {
    kind: "run_automation",
    label: "Run automation",
    icon: Play,
    group: "Automations",
    issue: false,
  },
  {
    kind: "set_automation_enabled",
    label: "Turn automation on or off",
    icon: Power,
    group: "Automations",
    issue: false,
  },
  {
    kind: "send_webhook",
    label: "Send webhook",
    icon: Send,
    group: "Integrations",
    issue: false,
  },
];

export const automationOutcomeLabels: Record<AutomationOutcome, string> = {
  succeeded: "Succeeds",
  failed: "Fails",
  skipped: "Is skipped",
};

export const gitEventLabels: Record<GitEventKind, string> = {
  push: "Commits pushed",
  branch_created: "Branch created",
  branch_deleted: "Branch deleted",
  tag_created: "Tag created",
  pull_request_opened: "Pull request opened",
  pull_request_updated: "New commits on pull request",
  pull_request_ready: "Ready for review",
  pull_request_draft: "Converted to draft",
  pull_request_merged: "Pull request merged",
  pull_request_closed: "Pull request closed",
  pull_request_reopened: "Pull request reopened",
  review_approved: "Approved",
  review_changes_requested: "Changes requested",
  review_commented: "Review comment",
  review_dismissed: "Approval withdrawn",
  comment_created: "Comment added",
  checks_passed: "Checks passed",
  checks_failed: "Checks failed",
  stack_base_merged: "Stacked base merged",
};

export function triggerLabel(trigger: string): string {
  if (trigger === "automation") return "Another automation";
  return (
    gitEventLabels[trigger as GitEventKind] ??
    triggerKinds.find((entry) => entry.kind === trigger)?.label ??
    trigger
  );
}

export const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export interface AutomationNames {
  workspace: CloudWorkspace;
  labels: CloudLabel[];
  products: CloudProduct[];
  automations: { id: string; name: string }[];
}

function automationNames(names: AutomationNames, ids: string[]): string[] {
  return ids.map(
    (id) =>
      names.automations.find((automation) => automation.id === id)?.name ??
      "Unavailable",
  );
}

function list(names: string[], fallback: string): string {
  if (!names.length) return fallback;
  return names.length > 2
    ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
    : names.join(" or ");
}

function statusNames(names: AutomationNames, ids: string[]): string[] {
  const statuses = names.workspace.workflows.flatMap(
    (workflow) => workflow.statuses,
  );
  return ids.map(
    (id) => statuses.find((status) => status.id === id)?.name ?? "Unavailable",
  );
}

function labelNames(names: AutomationNames, ids: string[]): string[] {
  return ids.map(
    (id) => names.labels.find((label) => label.id === id)?.name ?? "label",
  );
}

export function describeTrigger(
  trigger: AutomationTrigger,
  names: AutomationNames,
): string {
  switch (trigger.kind) {
    case "status_changed":
      return trigger.statusIds.length
        ? `Status changes to ${list(statusNames(names, trigger.statusIds), "")}`
        : "Status changes";
    case "priority_changed":
      return trigger.priorities.length
        ? `Priority changes to ${list(
            trigger.priorities.map((priority) => priorityNames[priority]),
            "",
          )}`
        : "Priority changes";
    case "label_added":
      return trigger.labelIds.length
        ? `${list(labelNames(names, trigger.labelIds), "")} is added`
        : "Label is added";
    case "comment_created":
      return trigger.contains
        ? `Comment mentions “${trigger.contains}”`
        : "Comment is added";
    case "pull_request_changed":
      return trigger.stages.length
        ? `Pull request is ${list(
            trigger.stages.map((stage) =>
              pullRequestStageLabels[stage].toLowerCase(),
            ),
            "",
          )}`
        : "Pull request changes";
    case "git_event": {
      const events = list(
        trigger.events.map((event) => gitEventLabels[event].toLowerCase()),
        "repository event",
      );
      const where = [
        trigger.branches.length ? `on ${trigger.branches.join(", ")}` : "",
        trigger.headBranches.length
          ? `from ${trigger.headBranches.join(", ")}`
          : "",
        trigger.actors.length ? `by ${trigger.actors.join(", ")}` : "",
      ].filter(Boolean);
      return [`${events[0]!.toUpperCase()}${events.slice(1)}`, ...where].join(
        " ",
      );
    }
    case "release_created":
      return trigger.productIds.length
        ? `${list(
            trigger.productIds.map(
              (id) =>
                names.products.find((product) => product.id === id)?.name ??
                "Unavailable",
            ),
            "",
          )} release is created`
        : "Release is created";
    case "automation_finished": {
      const outcome = list(
        trigger.outcomes.map((entry) =>
          automationOutcomeLabels[entry].toLowerCase(),
        ),
        "",
      );
      return `${list(automationNames(names, trigger.automationIds), "Another automation")} ${outcome}`;
    }
    case "schedule": {
      const when =
        trigger.frequency === "hourly"
          ? `Hourly at :${trigger.time.slice(3)}`
          : trigger.frequency === "daily"
            ? `Daily at ${trigger.time}`
            : trigger.frequency === "weekdays"
              ? `Weekdays at ${trigger.time}`
              : `${weekdays[trigger.weekday]}s at ${trigger.time}`;
      return trigger.forEachIssue ? `${when} for matching issues` : when;
    }
    default:
      return (
        triggerKinds.find((entry) => entry.kind === trigger.kind)?.label ?? ""
      );
  }
}

export function describeAction(
  action: AutomationAction,
  names: AutomationNames,
): string {
  switch (action.kind) {
    case "set_status":
      return `Set status to ${statusNames(names, [action.statusId])[0]}`;
    case "set_priority":
      return `Set priority to ${priorityNames[action.priority]}`;
    case "assign":
      return action.assignee === "trigger_actor"
        ? "Assign to whoever triggered it"
        : action.assignee === "unassigned"
          ? "Unassign"
          : `Assign to ${names.workspace.members.find((member) => member.id === action.assignee)?.name ?? "member"}`;
    case "add_labels":
      return `Add ${list(labelNames(names, action.labelIds), "labels")}`;
    case "remove_labels":
      return `Remove ${list(labelNames(names, action.labelIds), "labels")}`;
    case "comment":
      return "Add comment";
    case "create_issue":
      return action.subIssue ? "Create sub-issue" : "Create issue";
    case "ask_agent":
      return action.applyProposals ? "Agent acts" : "Ask Agent";
    case "delegate":
      return "Start AI task";
    case "git_comment":
      return "Comment on pull request";
    case "git_review":
      return action.decision === "approve"
        ? "Approve pull request"
        : action.decision === "request_changes"
          ? "Request changes"
          : "Review pull request";
    case "git_merge":
      return "Merge pull request";
    case "git_update_branch":
      return "Update branch";
    case "git_retarget":
      return "Retarget stacked pull request";
    case "send_webhook":
      return `Send webhook to ${new URL(action.url).hostname}`;
    case "write_project_updates":
      return action.projectIds.length
        ? `Write updates for ${list(
            action.projectIds.map(
              (id) =>
                names.workspace.projects.find((project) => project.id === id)
                  ?.name ?? "Unavailable",
            ),
            "",
          )}`
        : "Write project updates";
    case "run_automation":
      return `Run ${automationNames(names, [action.automationId])[0]}`;
    case "set_automation_enabled":
      return `${action.enabled ? "Turn on" : "Pause"} ${automationNames(names, [action.automationId])[0]}`;
    case "start_client_session":
      return action.goal ? "Start goal on client" : "Start on client";
    case "prepare_release":
      return action.providerId
        ? "Prepare release with Agent"
        : "Prepare release";
    case "write_release_posts": {
      const channels = action.channelKinds.length
        ? list(
            action.channelKinds.map((kind) => channelKindLabels[kind]),
            "",
          )
        : "channel";
      return action.minimumChanges
        ? `Write ${channels} posts after ${action.minimumChanges} ${action.measure === "points" ? "points" : "issues"}`
        : `Write ${channels} posts`;
    }
  }
}
