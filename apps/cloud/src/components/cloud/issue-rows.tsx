"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { KeyboardEvent, MouseEvent } from "react";
import type { CloudIssueSummary, CloudWorkspace } from "@/lib/cloud-contract";
import {
  AssigneeCell,
  EstimateCell,
  PriorityCell,
  RunIndicator,
  StatusCell,
  type ApplyChange,
} from "./issue-cells";
import { groupPoints, type IssueGroup } from "./issue-grouping";
import { IssuePriority } from "./issue-priority";
import { PersonAvatar } from "./person-avatar";

const shortDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function GroupHeading({ group }: { group: IssueGroup }) {
  const points = groupPoints(group);
  return (
    <h2 className="cloud-issue-group">
      {group.kind === "state" && (
        <span className="cloud-state" data-state={group.category} />
      )}
      {group.kind === "priority" && (
        <IssuePriority priority={group.priority!} compact />
      )}
      {group.kind === "assignee" && group.id !== "none" && (
        <PersonAvatar name={group.name} className="cloud-avatar-small" />
      )}
      <span>{group.name}</span>
      <span className="cloud-issue-group-count">{group.issues.length}</span>
      {points > 0 && (
        <span className="cloud-issue-group-points">{points} pts</span>
      )}
    </h2>
  );
}

export function IssueRows({
  groups,
  workspace,
  writable,
  apply,
  selected,
  onToggle,
  showProject = true,
}: {
  groups: IssueGroup[];
  workspace: CloudWorkspace;
  writable: boolean;
  apply: ApplyChange;
  selected: ReadonlySet<string>;
  onToggle: (id: string, range: boolean) => void;
  showProject?: boolean;
}) {
  const router = useRouter();
  const open = (event: MouseEvent<HTMLElement>, id: string) => {
    if (
      (event.target as HTMLElement).closest(
        "a,button,input,label,[data-radix-popper-content-wrapper]",
      )
    )
      return;
    if (event.metaKey || event.ctrlKey) {
      onToggle(id, false);
      return;
    }
    if (event.shiftKey) {
      onToggle(id, true);
      return;
    }
    router.push(`/cloud/issues/${id}`);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if ((event.target as HTMLElement).closest("input,[role=dialog]")) return;
    const links = [
      ...event.currentTarget.querySelectorAll<HTMLAnchorElement>(
        "a[data-issue-link]",
      ),
    ];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === "x" && index !== -1) {
      event.preventDefault();
      onToggle(links[index]!.dataset.issueLink!, event.shiftKey);
      return;
    }
    const step =
      event.key === "j" || event.key === "ArrowDown"
        ? 1
        : event.key === "k" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    const next = index === -1 ? links[0] : links[index + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  return (
    <div
      className="cloud-issue-rows"
      role="region"
      aria-label="Issues"
      onKeyDown={onKeyDown}
    >
      {groups
        .filter((group) => group.issues.length)
        .map((group) => (
          <section key={group.id} aria-label={group.name}>
            {group.kind !== "none" && <GroupHeading group={group} />}
            <ul>
              {group.issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  workspace={workspace}
                  writable={writable}
                  apply={apply}
                  checked={selected.has(issue.id)}
                  onToggle={onToggle}
                  onOpen={open}
                  showProject={showProject}
                />
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function IssueRow({
  issue,
  workspace,
  writable,
  apply,
  checked,
  onToggle,
  onOpen,
  showProject,
}: {
  issue: CloudIssueSummary;
  workspace: CloudWorkspace;
  writable: boolean;
  apply: ApplyChange;
  checked: boolean;
  onToggle: (id: string, range: boolean) => void;
  onOpen: (event: MouseEvent<HTMLElement>, id: string) => void;
  showProject: boolean;
}) {
  const project = showProject
    ? workspace.projects.find((entry) => entry.id === issue.projectId)
    : undefined;
  const cycle = workspace.cycles.find((entry) => entry.id === issue.cycleId);
  return (
    <li
      className="cloud-issue-row"
      data-issue={issue.id}
      data-selected={checked || undefined}
      onClick={(event) => onOpen(event, issue.id)}
    >
      {writable && (
        <label className="cloud-issue-check">
          <input
            type="checkbox"
            aria-label={`Select ${issue.identifier}`}
            checked={checked}
            onClick={(event) => {
              event.stopPropagation();
              if (event.shiftKey) {
                event.preventDefault();
                onToggle(issue.id, true);
              }
            }}
            onChange={() => onToggle(issue.id, false)}
          />
        </label>
      )}
      <PriorityCell issue={issue} writable={writable} apply={apply} />
      <span className="cloud-issue-cell-key">{issue.identifier}</span>
      <StatusCell
        issue={issue}
        workspace={workspace}
        writable={writable}
        apply={apply}
      />
      <Link
        className="cloud-issue-cell-title"
        data-issue-link={issue.id}
        href={`/cloud/issues/${issue.id}`}
        prefetch={false}
      >
        {issue.title}
      </Link>
      <RunIndicator issue={issue} />
      <span className="cloud-issue-cell-meta">
        {issue.labels.map((label) => (
          <span
            key={label.id}
            className="cloud-issue-label"
            data-label-color={label.color}
          >
            {label.name}
          </span>
        ))}
        {project && <span className="cloud-issue-chip">{project.name}</span>}
        {cycle && (
          <span className="cloud-issue-chip cloud-issue-chip-cycle">
            {cycle.name}
          </span>
        )}
        {issue.dueOn && (
          <span className="cloud-issue-chip">
            Due {shortDate.format(new Date(issue.dueOn))}
          </span>
        )}
      </span>
      <EstimateCell
        issue={issue}
        workspace={workspace}
        writable={writable}
        apply={apply}
      />
      <AssigneeCell
        issue={issue}
        workspace={workspace}
        writable={writable}
        apply={apply}
      />
      <time className="cloud-issue-cell-updated" dateTime={issue.updatedAt}>
        {shortDate.format(new Date(issue.updatedAt))}
      </time>
    </li>
  );
}
