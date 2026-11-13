import type { CloudIssue } from "./cloud-contract";
import type {
  AutomationOutcome,
  AutomationTrigger,
} from "./cloud-automation-contract";
import type { PullRequestStage } from "./git-automation";
import { gitEventMatches, type GitEvent } from "./git-events";

export type AutomationEvent =
  | { kind: "issue_created" }
  | { kind: "status_changed"; fromStatusId: string; toStatusId: string }
  | {
      kind: "priority_changed";
      from: CloudIssue["priority"];
      to: CloudIssue["priority"];
    }
  | {
      kind: "assignee_changed";
      from: string | null;
      to: string | null;
    }
  | { kind: "label_added"; labelIds: string[] }
  | { kind: "comment_created"; commentId: string; body: string }
  | {
      kind: "pull_request_changed";
      pullRequestId: string;
      stage: PullRequestStage;
      title: string;
      url: string;
    }
  | { kind: "git_event"; git: GitEvent }
  | {
      kind: "automation_finished";
      automationId: string;
      automationName: string;
      runId: string;
      outcome: AutomationOutcome;
      error: string | null;
    };

type IssueSnapshot = Pick<
  CloudIssue,
  "status" | "priority" | "assigneeId"
> | null;

export function issueChangeEvents(
  previous: IssueSnapshot,
  next: NonNullable<IssueSnapshot>,
): AutomationEvent[] {
  if (!previous) return [{ kind: "issue_created" }];
  const events: AutomationEvent[] = [];
  if (previous.status.id !== next.status.id)
    events.push({
      kind: "status_changed",
      fromStatusId: previous.status.id,
      toStatusId: next.status.id,
    });
  if (previous.priority !== next.priority)
    events.push({
      kind: "priority_changed",
      from: previous.priority,
      to: next.priority,
    });
  if (previous.assigneeId !== next.assigneeId)
    events.push({
      kind: "assignee_changed",
      from: previous.assigneeId,
      to: next.assigneeId,
    });
  return events;
}

export function triggerMatchesEvent(
  trigger: AutomationTrigger,
  event: AutomationEvent,
): boolean {
  if (trigger.kind !== event.kind) return false;
  switch (event.kind) {
    case "issue_created":
    case "assignee_changed":
      return true;
    case "status_changed":
      return (
        trigger.kind === "status_changed" &&
        (!trigger.statusIds.length ||
          trigger.statusIds.includes(event.toStatusId))
      );
    case "priority_changed":
      return (
        trigger.kind === "priority_changed" &&
        (!trigger.priorities.length || trigger.priorities.includes(event.to))
      );
    case "label_added":
      return (
        trigger.kind === "label_added" &&
        event.labelIds.length > 0 &&
        (!trigger.labelIds.length ||
          event.labelIds.some((id) => trigger.labelIds.includes(id)))
      );
    case "comment_created":
      return (
        trigger.kind === "comment_created" &&
        (!trigger.contains ||
          event.body.toLowerCase().includes(trigger.contains.toLowerCase()))
      );
    case "pull_request_changed":
      return (
        trigger.kind === "pull_request_changed" &&
        (!trigger.stages.length || trigger.stages.includes(event.stage))
      );
    case "git_event":
      return (
        trigger.kind === "git_event" && gitEventMatches(trigger, event.git)
      );
    case "automation_finished":
      return (
        trigger.kind === "automation_finished" &&
        trigger.outcomes.includes(event.outcome) &&
        (!trigger.automationIds.length ||
          trigger.automationIds.includes(event.automationId))
      );
  }
}
