"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import type {
  CloudCycle,
  CloudIssueSummary,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { EstimateCell, PriorityCell, StatusCell } from "./issue-cells";
import { sortIssues } from "./issue-grouping";
import { useIssueList } from "./use-issue-list";

const dragType = "application/x-machdoch-issue";

function PlanColumn({
  title,
  issues,
  workspace,
  writable,
  apply,
  moveLabel,
  onMove,
  onDropIssue,
  meter,
}: {
  title: string;
  issues: CloudIssueSummary[];
  workspace: CloudWorkspace;
  writable: boolean;
  apply: ReturnType<typeof useIssueList>["apply"];
  moveLabel: string;
  onMove: (issue: CloudIssueSummary) => void;
  onDropIssue: (id: string) => void;
  meter?: React.ReactNode;
}) {
  const [target, setTarget] = useState(false);
  return (
    <section
      className="cloud-plan-column"
      aria-label={title}
      data-drop-target={target || undefined}
      onDragOver={(event) => {
        if (!writable || !event.dataTransfer.types.includes(dragType)) return;
        event.preventDefault();
        setTarget(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setTarget(false);
      }}
      onDrop={(event) => {
        setTarget(false);
        const id = event.dataTransfer.getData(dragType);
        if (!id || issues.some((issue) => issue.id === id)) return;
        event.preventDefault();
        onDropIssue(id);
      }}
    >
      <header>
        <h2>{title}</h2>
        <span className="cloud-issue-group-count">{issues.length}</span>
        {meter}
      </header>
      <ul>
        {issues.map((issue) => (
          <li
            key={issue.id}
            className="cloud-plan-row"
            draggable={writable}
            onDragStart={(event) => {
              event.dataTransfer.setData(dragType, issue.id);
              event.dataTransfer.effectAllowed = "move";
            }}
          >
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
              href={`/cloud/issues/${issue.id}`}
              prefetch={false}
              draggable={false}
            >
              {issue.title}
            </Link>
            <EstimateCell
              issue={issue}
              workspace={workspace}
              writable={writable}
              apply={apply}
            />
            {writable && (
              <Button
                variant="ghost"
                size="icon"
                className="cloud-plan-move"
                aria-label={`${moveLabel} ${issue.identifier}`}
                onClick={() => onMove(issue)}
              >
                <ArrowLeftRight />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CyclePlanner({
  cycle,
  workspace,
  scheduled,
  backlog,
}: {
  cycle: CloudCycle;
  workspace: CloudWorkspace;
  scheduled: CloudIssueSummary[];
  backlog: CloudIssueSummary[];
}) {
  const initial = useMemo(
    () => [...scheduled, ...backlog],
    [scheduled, backlog],
  );
  const { issues, apply } = useIssueList(initial, workspace);
  const writable = workspace.actor.role !== "viewer";
  const inCycle = sortIssues(
    issues.filter((issue) => issue.cycleId === cycle.id),
    null,
  );
  const unplanned = sortIssues(
    issues.filter((issue) => issue.cycleId !== cycle.id),
    null,
  );
  const points = inCycle.reduce(
    (total, issue) => total + (issue.estimatePoints ?? 0),
    0,
  );
  const capacity = cycle.capacity;
  const percent = capacity
    ? Math.min(100, Math.round((points / capacity) * 100))
    : 0;
  const unestimated = inCycle.filter((issue) => !issue.estimate).length;
  const move = (id: string, cycleId: string | null) => {
    const issue = issues.find((entry) => entry.id === id);
    if (issue) apply([issue], { cycleId });
  };
  return (
    <>
      <header className="cloud-page-header">
        <div>
          <Link className="cloud-cycle-back" href={`/cloud/cycles/${cycle.id}`}>
            <ArrowLeft size={13} aria-hidden="true" />
            {cycle.name}
          </Link>
          <h1>Plan cycle</h1>
        </div>
      </header>
      <div className="cloud-plan">
        <PlanColumn
          title="Backlog"
          issues={unplanned}
          workspace={workspace}
          writable={writable}
          apply={apply}
          moveLabel="Add to cycle"
          onMove={(issue) => move(issue.id, cycle.id)}
          onDropIssue={(id) => move(id, null)}
        />
        <PlanColumn
          title={cycle.name}
          issues={inCycle}
          workspace={workspace}
          writable={writable}
          apply={apply}
          moveLabel="Remove from cycle"
          onMove={(issue) => move(issue.id, null)}
          onDropIssue={(id) => move(id, cycle.id)}
          meter={
            <div className="cloud-plan-meter" data-over={
              capacity !== null && points > capacity ? true : undefined
            }>
              <span>
                {points}
                {capacity !== null ? ` / ${capacity}` : ""} points
                {unestimated ? ` · ${unestimated} not estimated` : ""}
              </span>
              {capacity !== null && (
                <span
                  className="cloud-project-progress-track"
                  role="progressbar"
                  aria-label="Capacity used"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <span style={{ width: `${percent}%` }} />
                </span>
              )}
            </div>
          }
        />
      </div>
    </>
  );
}
