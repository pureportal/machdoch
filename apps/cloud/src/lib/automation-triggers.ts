import type { CloudIssue } from "./cloud-contract";
import type {
  AutomationOutcome,
  AutomationTrigger,
  ClientEventKind,
  CycleEventKind,
  IntakeSource,
  ProjectEventKind,
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
  | { kind: "issue_triaged" }
  | {
      kind: "project_event";
      event: ProjectEventKind;
      projectId: string;
      projectName: string;
    }
  | {
      kind: "cycle_event";
      event: CycleEventKind;
      cycleId: string;
      cycleName: string;
    }
  | {
      kind: "source_event";
      source: IntakeSource;
      title: string;
      body: string;
      payload: unknown;
    }
  | {
      kind: "client_event";
      event: ClientEventKind;
      instanceId: string;
      instanceName: string;
      path: string | null;
    }
  | {
      kind: "release_event";
      pipelineId: string;
      releaseId: string;
      environment: string;
      version: string;
    }
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
  "state" | "status" | "priority" | "assigneeId"
> | null;

export function issueChangeEvents(
  previous: IssueSnapshot,
  next: NonNullable<IssueSnapshot>,
): AutomationEvent[] {
  const triaged: AutomationEvent[] =
    next.state === "triage" && previous?.state !== "triage"
      ? [{ kind: "issue_triaged" }]
      : [];
  if (!previous) return [{ kind: "issue_created" }, ...triaged];
  const events: AutomationEvent[] = [...triaged];
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
    case "issue_triaged":
      return true;
    case "project_event":
      return (
        trigger.kind === "project_event" && trigger.events.includes(event.event)
      );
    case "cycle_event":
      return (
        trigger.kind === "cycle_event" && trigger.events.includes(event.event)
      );
    case "source_event":
      return (
        trigger.kind === "source_event" &&
        trigger.source === event.source &&
        (!trigger.contains ||
          `${event.title}\n${event.body}`
            .toLowerCase()
            .includes(trigger.contains.toLowerCase()))
      );
    case "client_event":
      return (
        trigger.kind === "client_event" &&
        trigger.events.includes(event.event) &&
        (!trigger.instanceIds.length ||
          trigger.instanceIds.includes(event.instanceId))
      );
    case "release_event":
      return (
        trigger.kind === "release_event" &&
        (!trigger.pipelineIds.length ||
          trigger.pipelineIds.includes(event.pipelineId))
      );
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
