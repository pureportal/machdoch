import type { CloudWorkspace, IssueSnapshot } from "@/lib/cloud-contract";

export interface IssueHistoryEntry {
  revision: number;
  actor: string;
  snapshot: IssueSnapshot;
  statusName: string;
  createdAt: string;
}

export interface IssueChangeEntry {
  id: string;
  actor: string;
  createdAt: string;
  description: string;
}

export function issueChangeEntries(
  history: IssueHistoryEntry[],
  workspace: CloudWorkspace,
): IssueChangeEntry[] {
  const ordered = [...history].sort(
    (left, right) => left.revision - right.revision,
  );
  const entries: IssueChangeEntry[] = [];
  ordered.forEach((entry, index) => {
    const before = ordered[index - 1];
    const after = entry.snapshot;
    const parts: string[] = [];
    if (!before) parts.push("created the issue");
    else {
      const previous = before.snapshot;
      const memberName = (id: string | null) =>
        workspace.members.find((member) => member.id === id)?.name;
      if (entry.statusName !== before.statusName)
        parts.push(`changed status to ${entry.statusName}`);
      if (after.priority !== previous.priority)
        parts.push(`set priority to ${after.priority}`);
      if (after.assigneeId !== previous.assigneeId)
        parts.push(
          after.assigneeId
            ? `assigned ${memberName(after.assigneeId) ?? "a member"}`
            : "removed the assignee",
        );
      if (after.estimate !== previous.estimate)
        parts.push(
          after.estimate
            ? `estimated ${after.estimate}`
            : "removed the estimate",
        );
      if (after.projectId !== previous.projectId)
        parts.push(
          after.projectId
            ? `moved to ${workspace.projects.find((project) => project.id === after.projectId)?.name ?? "a project"}`
            : "removed the project",
        );
      if (after.cycleId !== previous.cycleId)
        parts.push(
          after.cycleId
            ? `moved to ${workspace.cycles.find((cycle) => cycle.id === after.cycleId)?.name ?? "a cycle"}`
            : "removed the cycle",
        );
      if (after.dueOn !== previous.dueOn)
        parts.push(after.dueOn ? `set due date ${after.dueOn}` : "cleared the due date");
      if (after.title !== previous.title) parts.push("renamed the issue");
      if (after.description !== previous.description)
        parts.push("edited the description");
      if (after.acceptanceCriteria !== previous.acceptanceCriteria)
        parts.push("edited the acceptance criteria");
      if (after.archived !== previous.archived)
        parts.push(after.archived ? "archived the issue" : "restored the issue");
    }
    if (parts.length)
      entries.push({
        id: `change-${entry.revision}`,
        actor: entry.actor,
        createdAt: entry.createdAt,
        description: parts.join(", "),
      });
  });
  return entries;
}
