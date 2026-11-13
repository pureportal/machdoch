"use client";

import { useState } from "react";
import type { CloudIssueSummary, CloudWorkspace } from "@/lib/cloud-contract";
import {
  breakdownKinds,
  issueBreakdown,
  type BreakdownKind,
} from "@/lib/issue-breakdown";
import { PersonAvatar } from "./person-avatar";

function entryName(
  kind: BreakdownKind,
  id: string | null,
  issues: CloudIssueSummary[],
  workspace: CloudWorkspace,
): string {
  if (kind === "assignee")
    return id
      ? (workspace.members.find((member) => member.id === id)?.name ??
          "Former member")
      : "Unassigned";
  if (kind === "project")
    return id
      ? (workspace.projects.find((project) => project.id === id)?.name ??
          "Project")
      : "No project";
  return id
    ? (issues.flatMap((issue) => issue.labels).find((label) => label.id === id)
        ?.name ?? "Label")
    : "No label";
}

export function IssueBreakdownCard({
  issues,
  workspace,
}: {
  issues: CloudIssueSummary[];
  workspace: CloudWorkspace;
}) {
  const [kind, setKind] = useState<BreakdownKind>("assignee");
  const entries = issueBreakdown(issues, kind);
  return (
    <section className="cloud-card cloud-breakdown" aria-label="Breakdown">
      <div className="cloud-breakdown-tabs" role="group" aria-label="Group by">
        {(Object.keys(breakdownKinds) as BreakdownKind[]).map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={kind === entry}
            onClick={() => setKind(entry)}
          >
            {breakdownKinds[entry]}
          </button>
        ))}
      </div>
      {!entries.length ? (
        <p className="cloud-empty-inline">No issues.</p>
      ) : (
        <ul>
          {entries.map((entry) => {
            const name = entryName(kind, entry.id, issues, workspace);
            const percent = Math.round((entry.completed / entry.total) * 100);
            return (
              <li key={entry.id ?? "none"}>
                {kind === "assignee" && entry.id && (
                  <PersonAvatar name={name} className="cloud-avatar-tiny" />
                )}
                <span className="cloud-breakdown-name">{name}</span>
                <progress
                  value={entry.completed}
                  max={entry.total}
                  aria-label={`${name}: ${entry.completed} of ${entry.total} completed`}
                />
                <span className="cloud-breakdown-count">
                  {percent}% <span>of {entry.total}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
