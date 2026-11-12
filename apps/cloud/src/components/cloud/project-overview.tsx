"use client";

import { useEffect, useState } from "react";
import type {
  CloudIssueSummary,
  CloudProject,
  CloudProjectProgress,
} from "@/lib/cloud-contract";
import { daysUntil, projectStateBreakdown } from "@/lib/project-progress";
import { stateNames } from "./issue-properties";

const projectDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatProjectDate(value: string): string {
  return projectDate.format(new Date(`${value}T00:00:00Z`));
}

function targetLabel(days: number): string {
  if (days === 0) return "Due today";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  return `${days} day${days === 1 ? "" : "s"} left`;
}

export function ProjectOverview({
  project,
  progress,
  issues,
}: {
  project: CloudProject;
  progress: CloudProjectProgress | undefined;
  issues: CloudIssueSummary[];
}) {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => setToday(new Date().toLocaleDateString("en-CA")), []);
  const breakdown = projectStateBreakdown(issues);
  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  const days =
    project.targetOn && today ? daysUntil(project.targetOn, today) : null;
  const finished =
    project.status === "completed" || project.status === "canceled";
  return (
    <section className="cloud-project-overview" aria-label="Progress">
      <dl className="cloud-project-figures">
        <div>
          <dt>Complete</dt>
          <dd>{percent}%</dd>
        </div>
        <div>
          <dt>Issues</dt>
          <dd>
            {completed}
            <span>/{total}</span>
          </dd>
        </div>
        {(progress?.points ?? 0) > 0 && (
          <div>
            <dt>Points</dt>
            <dd>
              {progress!.completedPoints}
              <span>/{progress!.points}</span>
            </dd>
          </div>
        )}
        {project.targetOn && (
          <div
            data-overdue={(!finished && days !== null && days < 0) || undefined}
          >
            <dt>Target</dt>
            <dd>
              {formatProjectDate(project.targetOn)}
              {!finished && days !== null && <small>{targetLabel(days)}</small>}
            </dd>
          </div>
        )}
      </dl>
      {breakdown.total > 0 && (
        <>
          <div
            className="cloud-project-bar"
            role="img"
            aria-label={breakdown.segments
              .map((segment) => `${segment.count} ${stateNames[segment.state]}`)
              .join(", ")}
          >
            {breakdown.segments.map((segment) => (
              <span
                key={segment.state}
                data-state={segment.state}
                style={{ flexGrow: segment.count }}
              />
            ))}
          </div>
          <ul className="cloud-project-legend">
            {breakdown.segments.map((segment) => (
              <li key={segment.state}>
                <span
                  className="cloud-state"
                  data-state={segment.state}
                  aria-hidden="true"
                />
                {stateNames[segment.state]}
                <strong>{segment.count}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
