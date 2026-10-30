"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KeyboardEvent, MouseEvent } from "react";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import { IssuePriority } from "./issue-priority";
import { PersonAvatar } from "./person-avatar";

export interface IssueGroup {
  id: string;
  name: string;
  category: CloudIssue["state"];
  issues: CloudIssue[];
}

const priorityRank: Record<CloudIssue["priority"], number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
  none: 4,
};
const shortDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function sortIssues(issues: CloudIssue[]): CloudIssue[] {
  return [...issues].sort(
    (left, right) =>
      priorityRank[left.priority] - priorityRank[right.priority] ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
}

function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const step =
    event.key === "j" || event.key === "ArrowDown"
      ? 1
      : event.key === "k" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (!step) return;
  const links = [
    ...event.currentTarget.querySelectorAll<HTMLAnchorElement>(
      "a[data-issue-link]",
    ),
  ];
  const index = links.indexOf(document.activeElement as HTMLAnchorElement);
  const next = index === -1 ? links[0] : links[index + step];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

export function IssueRows({
  groups,
  workspace,
}: {
  groups: IssueGroup[];
  workspace: CloudWorkspace;
}) {
  const router = useRouter();
  const open = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    if ((event.target as HTMLElement).closest("a,button")) return;
    router.push(`/cloud/issues/${id}`);
  };
  return (
    <div
      className="cloud-issue-rows"
      role="region"
      aria-label="Issues"
      onKeyDown={moveFocus}
    >
      <table>
        <colgroup>
          <col className="cloud-issue-col-priority" />
          <col className="cloud-issue-col-key" />
          <col className="cloud-issue-col-status" />
          <col />
          <col className="cloud-issue-col-meta" />
          <col className="cloud-issue-col-assignee" />
          <col className="cloud-issue-col-updated" />
        </colgroup>
        {groups
          .filter((group) => group.issues.length)
          .map((group) => (
            <tbody key={group.id}>
              <tr className="cloud-issue-group">
                <th colSpan={7} scope="colgroup">
                  <span className="cloud-state" data-state={group.category}>
                    {group.name}
                  </span>
                  <span className="cloud-issue-group-count">
                    {group.issues.length}
                  </span>
                </th>
              </tr>
              {group.issues.map((issue) => {
                const assignee = workspace.members.find(
                  (member) => member.id === issue.assigneeId,
                );
                const project = workspace.projects.find(
                  (entry) => entry.id === issue.projectId,
                );
                const cycle = workspace.cycles.find(
                  (entry) => entry.id === issue.cycleId,
                );
                return (
                  <tr
                    key={issue.id}
                    data-issue={issue.id}
                    onClick={(event) => open(event, issue.id)}
                  >
                    <td className="cloud-issue-cell-priority">
                      <IssuePriority priority={issue.priority} compact />
                    </td>
                    <td className="cloud-issue-cell-key">{issue.identifier}</td>
                    <td className="cloud-issue-cell-status">
                      <span
                        className="cloud-state"
                        data-state={issue.state}
                        title={issue.statusName}
                      >
                        <span className="sr-only">{issue.statusName}</span>
                      </span>
                    </td>
                    <td className="cloud-issue-cell-title">
                      <Link data-issue-link href={`/cloud/issues/${issue.id}`}>
                        {issue.title}
                      </Link>
                    </td>
                    <td className="cloud-issue-cell-meta">
                      {project && (
                        <span className="cloud-issue-chip">{project.name}</span>
                      )}
                      {cycle && (
                        <span className="cloud-issue-chip">{cycle.name}</span>
                      )}
                      {issue.dueOn && (
                        <span className="cloud-issue-chip">
                          Due {shortDate.format(new Date(issue.dueOn))}
                        </span>
                      )}
                      {issue.estimate && (
                        <span
                          className="cloud-issue-estimate"
                          aria-label={`Estimate ${issue.estimate}`}
                        >
                          {issue.estimate}
                        </span>
                      )}
                    </td>
                    <td className="cloud-issue-cell-assignee">
                      {assignee ? (
                        <span title={assignee.name}>
                          <PersonAvatar name={assignee.name} />
                          <span className="sr-only">{assignee.name}</span>
                        </span>
                      ) : (
                        <span className="cloud-avatar-empty" title="Unassigned">
                          <span className="sr-only">Unassigned</span>
                        </span>
                      )}
                    </td>
                    <td className="cloud-issue-cell-updated">
                      <time dateTime={issue.updatedAt}>
                        {shortDate.format(new Date(issue.updatedAt))}
                      </time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
      </table>
    </div>
  );
}
