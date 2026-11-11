import type { CloudWorkspace, IssueSnapshot } from "@/lib/cloud-contract";
import type { CloudIssueRelation } from "@/lib/cloud-relation-contract";

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
        parts.push(
          after.dueOn ? `set due date ${after.dueOn}` : "cleared the due date",
        );
      if (after.title !== previous.title) parts.push("renamed the issue");
      if (after.description !== previous.description)
        parts.push("edited the description");
      if (after.acceptanceCriteria !== previous.acceptanceCriteria)
        parts.push("edited the acceptance criteria");
      if (after.archived !== previous.archived)
        parts.push(
          after.archived ? "archived the issue" : "restored the issue",
        );
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

export type ActivityEntry<Comment> =
  | { kind: "comment"; at: string; comment: Comment }
  | { kind: "change"; at: string; change: IssueChangeEntry };
export type ActivityRow<Comment> =
  | ActivityEntry<Comment>
  | { kind: "collapsed"; id: string; changes: IssueChangeEntry[] };

const collapseThreshold = 3;

export function collapseActivity<Comment>(
  entries: ActivityEntry<Comment>[],
  expanded: ReadonlySet<string>,
): ActivityRow<Comment>[] {
  const rows: ActivityRow<Comment>[] = [];
  let run: IssueChangeEntry[] = [];
  const flush = () => {
    const hidden = run.slice(1, -1);
    if (run.length > collapseThreshold && !expanded.has(hidden[0]!.id))
      rows.push(
        { kind: "change", at: run[0]!.createdAt, change: run[0]! },
        { kind: "collapsed", id: hidden[0]!.id, changes: hidden },
        { kind: "change", at: run.at(-1)!.createdAt, change: run.at(-1)! },
      );
    else
      rows.push(
        ...run.map((change) => ({
          kind: "change" as const,
          at: change.createdAt,
          change,
        })),
      );
    run = [];
  };
  for (const entry of entries) {
    if (entry.kind === "change") {
      run.push(entry.change);
      continue;
    }
    flush();
    rows.push(entry);
  }
  flush();
  return rows;
}

const relationPhrases: Record<CloudIssueRelation["kind"], string> = {
  parent: "set the parent to",
  child: "added the sub-issue",
  blocks: "marked this as blocking",
  blocked_by: "marked this as blocked by",
  related: "linked the related issue",
  duplicate_of: "marked this as a duplicate of",
  duplicated_by: "marked as duplicated by",
};

export function relationChangeEntries(
  relations: CloudIssueRelation[],
): IssueChangeEntry[] {
  return relations.map((relation) => ({
    id: `relation-${relation.id}`,
    actor: relation.actor,
    createdAt: relation.createdAt,
    description: `${relationPhrases[relation.kind]} ${relation.issue.identifier} ${relation.issue.title}`,
  }));
}
