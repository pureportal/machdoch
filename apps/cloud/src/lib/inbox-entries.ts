import type { InboxEntry, InboxKind } from "./cloud-inbox-contract";

export const loopInboxKinds: InboxKind[] = [
  "loop_input",
  "loop_approval",
  "loop_message",
];

export function describeInboxEntry(entry: InboxEntry): string {
  const actor = entry.actor ?? "Someone";
  if (entry.kind === "assigned") return `${actor} assigned you`;
  if (entry.kind === "mentioned")
    return `${actor} mentioned you: ${entry.detail}`;
  if (entry.kind === "commented") return `${actor} commented: ${entry.detail}`;
  if (entry.kind === "status_changed")
    return `${actor} changed the status to ${entry.detail}`;
  if (entry.kind === "pull_request") return entry.detail;
  if (entry.kind === "loop_input") return `Input needed: ${entry.detail}`;
  if (entry.kind === "loop_approval") return `Approval needed: ${entry.detail}`;
  if (entry.kind === "loop_message") return entry.detail;
  if (entry.kind === "sla_breached") return "SLA breached";
  if (entry.kind === "project_update_due") return "Project update due";
  if (entry.kind === "project_update_drafted")
    return "Project update drafted for review";
  return `AI task ${(entry.runState ?? "finished").replaceAll("_", " ")}${entry.detail ? `: ${entry.detail}` : ""}`;
}

export function inboxEntryPath(entry: InboxEntry): string {
  if (entry.projectId) return `/cloud/projects/${entry.projectId}`;
  if (loopInboxKinds.includes(entry.kind) && entry.loopId)
    return `/cloud/automations/${entry.loopId}?run=${entry.automationRunId}`;
  return entry.kind === "task_finished" && entry.runId
    ? `/cloud/tasks/${entry.runId}`
    : `/cloud/issues/${entry.issueId}`;
}

export function inboxEntryTitle(entry: InboxEntry): string {
  if (entry.issueIdentifier)
    return `${entry.issueIdentifier} ${entry.issueTitle ?? ""}`.trim();
  return entry.projectName ?? entry.runTitle ?? "machdoch.cloud";
}
