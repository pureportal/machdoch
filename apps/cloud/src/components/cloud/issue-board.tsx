"use client";

import Link from "next/link";
import { useState } from "react";
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

const dragType = "application/x-machdoch-issue";

export function IssueBoard({
  groups,
  issues,
  workspace,
  writable,
  apply,
}: {
  groups: IssueGroup[];
  issues: CloudIssueSummary[];
  workspace: CloudWorkspace;
  writable: boolean;
  apply: ApplyChange;
}) {
  const [target, setTarget] = useState<string | null>(null);
  return (
    <div className="cloud-board">
      {groups.map((group) => (
        <section
          key={group.id}
          className="cloud-board-column"
          aria-label={group.name}
          data-drop-target={target === group.id || undefined}
          onDragOver={(event) => {
            if (!writable || !group.change) return;
            if (!event.dataTransfer.types.includes(dragType)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (target !== group.id) setTarget(group.id);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              setTarget((current) => (current === group.id ? null : current));
          }}
          onDrop={(event) => {
            setTarget(null);
            if (!writable || !group.change) return;
            const issue = issues.find(
              (entry) => entry.id === event.dataTransfer.getData(dragType),
            );
            if (!issue || group.issues.includes(issue)) return;
            event.preventDefault();
            apply([issue], group.change);
          }}
        >
          <h2>
            {group.kind === "state" && (
              <span className="cloud-state" data-state={group.category} />
            )}
            {group.kind === "priority" && (
              <IssuePriority priority={group.priority!} compact />
            )}
            {group.kind === "assignee" && group.id !== "none" && (
              <PersonAvatar name={group.name} className="cloud-avatar-small" />
            )}
            <span className="cloud-board-column-name">{group.name}</span>
            <span className="cloud-board-count">{group.issues.length}</span>
            {groupPoints(group) > 0 && (
              <span className="cloud-board-count">
                {groupPoints(group)} pts
              </span>
            )}
          </h2>
          <div className="cloud-board-cards">
            {group.issues.map((issue) => (
              <article
                key={issue.id}
                className="cloud-board-card"
                data-issue={issue.id}
                draggable={writable}
                onDragStart={(event) => {
                  event.dataTransfer.setData(dragType, issue.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
              >
                <div className="cloud-board-card-heading">
                  <span className="cloud-issue-key">{issue.identifier}</span>
                  <RunIndicator issue={issue} />
                  <AssigneeCell
                    issue={issue}
                    workspace={workspace}
                    writable={writable}
                    apply={apply}
                  />
                </div>
                <Link
                  className="cloud-issue-title"
                  href={`/cloud/issues/${issue.id}`}
                  prefetch={false}
                  draggable={false}
                >
                  {issue.title}
                </Link>
                <div className="cloud-board-card-footer">
                  <StatusCell
                    issue={issue}
                    workspace={workspace}
                    writable={writable}
                    apply={apply}
                  />
                  <PriorityCell
                    issue={issue}
                    writable={writable}
                    apply={apply}
                  />
                  <EstimateCell
                    issue={issue}
                    workspace={workspace}
                    writable={writable}
                    apply={apply}
                  />
                  {issue.labels.slice(0, 2).map((label) => (
                    <span
                      key={label.id}
                      className="cloud-issue-label"
                      data-label-color={label.color}
                    >
                      {label.name}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
