"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, FolderKanban } from "lucide-react";
import { CreateIssue } from "./issue-form";
import type { CloudIssueSummary, CloudWorkspace } from "@/lib/cloud-contract";
import type { IssueDensity } from "@/lib/issue-view-options";
import type { IssueDisplayProperty } from "@/lib/issue-display";
import {
  AssigneeCell,
  EstimateCell,
  PriorityCell,
  PullRequestIndicator,
  RunIndicator,
  StatusCell,
  type ApplyChange,
} from "./issue-cells";
import { groupPoints, type IssueGroup } from "./issue-grouping";
import { IssuePriority } from "./issue-priority";
import { PersonAvatar } from "./person-avatar";
import { useIssueDisplay } from "./use-issue-display";

const dragType = "application/x-machdoch-issue";
const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function IssueBoard({
  groups,
  issues,
  workspace,
  writable,
  apply,
  density = "comfortable",
  omit = [],
}: {
  groups: IssueGroup[];
  issues: CloudIssueSummary[];
  workspace: CloudWorkspace;
  writable: boolean;
  apply: ApplyChange;
  density?: IssueDensity;
  omit?: IssueDisplayProperty[];
}) {
  const [target, setTarget] = useState<string | null>(null);
  const router = useRouter();
  const display = useIssueDisplay();
  const shows = (property: IssueDisplayProperty) =>
    display.shows(property) && !omit.includes(property);
  const teamForGroup = (group: IssueGroup) =>
    group.change?.status
      ? workspace.workflows.find((workflow) =>
          workflow.statuses.some(
            (status) => status.id === group.change!.status!.id,
          ),
        )?.teamId
      : group.change?.projectId
        ? workspace.projects.find(
            (project) => project.id === group.change!.projectId,
          )?.teamId
        : group.change?.cycleId
          ? workspace.cycles.find((cycle) => cycle.id === group.change!.cycleId)
              ?.teamId
          : undefined;
  const projectName = (id: string | null) =>
    id
      ? (workspace.projects.find((project) => project.id === id)?.name ?? null)
      : null;
  return (
    <div className="cloud-board" data-density={density}>
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
            {writable && group.change && !group.change.statusCategory && (
              <span className="cloud-board-column-add">
                <CreateIssue
                  workspace={workspace}
                  teamId={teamForGroup(group)}
                  defaults={group.change}
                  compactLabel={`New issue in ${group.name}`}
                  onCreated={async () => router.refresh()}
                />
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
                  {shows("id") && (
                    <span className="cloud-issue-key">{issue.identifier}</span>
                  )}
                  <RunIndicator issue={issue} />
                  {shows("pullRequest") && (
                    <PullRequestIndicator issue={issue} />
                  )}
                  {shows("assignee") && (
                    <AssigneeCell
                      issue={issue}
                      workspace={workspace}
                      writable={writable}
                      apply={apply}
                    />
                  )}
                </div>
                {issue.parent && (
                  <Link
                    className="cloud-board-card-parent"
                    href={`/cloud/issues/${issue.parent.id}`}
                    prefetch={false}
                    draggable={false}
                  >
                    <span>{issue.parent.identifier}</span>
                    <ChevronRight size={11} aria-hidden="true" />
                    <span>{issue.parent.title}</span>
                  </Link>
                )}
                <Link
                  className="cloud-issue-title"
                  href={`/cloud/issues/${issue.id}`}
                  prefetch={false}
                  draggable={false}
                >
                  {issue.title}
                </Link>
                <div className="cloud-board-card-footer">
                  {shows("status") && (
                    <StatusCell
                      issue={issue}
                      workspace={workspace}
                      writable={writable}
                      apply={apply}
                    />
                  )}
                  {shows("priority") && (
                    <PriorityCell
                      issue={issue}
                      writable={writable}
                      apply={apply}
                    />
                  )}
                  {shows("estimate") && (
                    <EstimateCell
                      issue={issue}
                      workspace={workspace}
                      writable={writable}
                      apply={apply}
                    />
                  )}
                  {shows("project") && projectName(issue.projectId) && (
                    <span className="cloud-board-chip">
                      <FolderKanban size={11} aria-hidden="true" />
                      {projectName(issue.projectId)}
                    </span>
                  )}
                  {shows("labels") &&
                    issue.labels.slice(0, 3).map((label) => (
                      <span
                        key={label.id}
                        className="cloud-issue-label"
                        data-label-color={label.color}
                      >
                        {label.name}
                      </span>
                    ))}
                  {shows("due") && issue.dueOn && (
                    <span className="cloud-board-chip">
                      Due {dateFormat.format(new Date(issue.dueOn))}
                    </span>
                  )}
                </div>
                {shows("created") && (
                  <span className="cloud-board-card-created">
                    Created {dateFormat.format(new Date(issue.createdAt))}
                  </span>
                )}
                {shows("updated") && (
                  <span className="cloud-board-card-created">
                    Updated {dateFormat.format(new Date(issue.updatedAt))}
                  </span>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
