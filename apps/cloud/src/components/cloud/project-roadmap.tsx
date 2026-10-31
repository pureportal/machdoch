import Link from "next/link";
import { Map as MapIcon } from "lucide-react";
import type {
  CloudProject,
  CloudProjectProgress,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import type { CloudMilestone } from "@/lib/cloud-milestone-contract";
import { projectStatusLabels, projectStatusStates } from "./project-fields";

const dayMs = 86_400_000;
const monthsVisible = 9;
const minimumLabeledBarPercent = 5;

function parseDate(value: string): number {
  return new Date(`${value}T00:00:00Z`).getTime();
}

function monthStart(moment: number, offset = 0): number {
  const date = new Date(moment);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1);
}

function projectSpan(project: CloudProject): [number, number] | null {
  if (!project.startsOn && !project.targetOn) return null;
  const start = parseDate(project.startsOn ?? project.targetOn!);
  const end = parseDate(project.targetOn ?? project.startsOn!);
  return [start, end];
}

export function ProjectRoadmap({
  workspace,
  progress,
  milestones,
}: {
  workspace: CloudWorkspace;
  progress: CloudProjectProgress[];
  milestones: CloudMilestone[];
}) {
  const now = Date.now();
  const projects = workspace.projects
    .filter((project) => !["canceled"].includes(project.status))
    .sort(
      (left, right) =>
        (projectSpan(left)?.[0] ?? Infinity) -
          (projectSpan(right)?.[0] ?? Infinity) ||
        left.name.localeCompare(right.name),
    );
  const spans = [
    ...projects.flatMap((project) => projectSpan(project) ?? []),
    ...milestones.flatMap((milestone) =>
      milestone.targetOn ? parseDate(milestone.targetOn) : [],
    ),
  ];
  const rangeStart = monthStart(Math.min(now, ...spans), 0);
  const rangeEnd = Math.max(
    monthStart(now, monthsVisible),
    monthStart(Math.max(...spans, now), 1),
  );
  const span = rangeEnd - rangeStart;
  const position = (moment: number) =>
    `${(((moment - rangeStart) / span) * 100).toFixed(3)}%`;
  const months: number[] = [];
  for (let month = rangeStart; month < rangeEnd; month = monthStart(month, 1))
    months.push(month);
  const activeCycles = workspace.cycles.filter(
    (cycle) => cycle.status !== "closed",
  );
  return (
    <>
      <header className="cloud-page-header">
        <h1>Roadmap</h1>
      </header>
      {!projects.length ? (
        <div className="cloud-empty">
          <MapIcon aria-hidden="true" />
          <p>No projects yet.</p>
          <Link className="underline" href="/cloud/projects">
            Create a project
          </Link>
        </div>
      ) : (
        <div className="cloud-roadmap" role="region" aria-label="Project roadmap">
          <div
            className="cloud-roadmap-scroll"
            style={{ "--roadmap-months": months.length } as React.CSSProperties}
          >
            <div className="cloud-roadmap-months" aria-hidden="true">
              <span className="cloud-roadmap-corner" />
              <div className="cloud-roadmap-track">
                {months.map((month, index) => (
                  <span
                    key={month}
                    style={{ left: position(month) }}
                    data-first={index === 0 || undefined}
                  >
                    {new Date(month).toLocaleDateString("en", {
                      month: "short",
                      year:
                        index === 0 || new Date(month).getUTCMonth() === 0
                          ? "numeric"
                          : undefined,
                      timeZone: "UTC",
                    })}
                  </span>
                ))}
              </div>
            </div>
            {activeCycles.length > 0 && (
              <div className="cloud-roadmap-row cloud-roadmap-cycles">
                <span className="cloud-roadmap-name">Cycles</span>
                <div className="cloud-roadmap-track">
                  {activeCycles.map((cycle) => {
                    const start = parseDate(cycle.startsOn);
                    const end = parseDate(cycle.endsOn);
                    return (
                      <Link
                        key={cycle.id}
                        href={`/cloud/cycles/${cycle.id}`}
                        prefetch={false}
                        className="cloud-roadmap-cycle"
                        data-status={cycle.status}
                        title={cycle.name}
                        style={{
                          left: position(start),
                          width: `calc(${(((end - start) / span) * 100).toFixed(3)}% - 2px)`,
                        }}
                      >
                        <span className="sr-only">{cycle.name}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
            {projects.map((project) => {
              const range = projectSpan(project);
              const counts = progress.find(
                (entry) => entry.projectId === project.id,
              );
              const percent = counts?.total
                ? Math.round((counts.completed / counts.total) * 100)
                : 0;
              const start = range?.[0] ?? 0;
              const end = range?.[1] ?? 0;
              const barPercent = ((end - start + dayMs) / span) * 100;
              return (
                <div className="cloud-roadmap-row" key={project.id}>
                  <Link
                    className="cloud-roadmap-name"
                    href={`/cloud/projects/${project.id}`}
                    prefetch={false}
                  >
                    <span
                      className="cloud-state"
                      data-state={projectStatusStates[project.status]}
                      title={projectStatusLabels[project.status]}
                    />
                    <span>{project.name}</span>
                  </Link>
                  <div className="cloud-roadmap-track">
                    {range && (
                      <Link
                        href={`/cloud/projects/${project.id}`}
                        prefetch={false}
                        tabIndex={-1}
                        className="cloud-roadmap-bar"
                        data-status={project.status}
                        title={`${project.name}: ${percent}%`}
                        style={{
                          left: position(start),
                          width: `max(10px, ${barPercent.toFixed(3)}%)`,
                        }}
                      >
                        <span
                          className="cloud-roadmap-bar-progress"
                          style={{ width: `${percent}%` }}
                        />
                        {barPercent >= minimumLabeledBarPercent && (
                          <span className="cloud-roadmap-bar-label">
                            {percent}%
                          </span>
                        )}
                      </Link>
                    )}
                    {milestones
                      .filter(
                        (milestone) =>
                          milestone.projectId === project.id &&
                          milestone.targetOn,
                      )
                      .map((milestone) => (
                        <span
                          key={milestone.id}
                          className="cloud-roadmap-milestone"
                          data-completed={milestone.completed || undefined}
                          title={`${milestone.name} · ${milestone.targetOn}`}
                          style={{
                            left: position(parseDate(milestone.targetOn!)),
                          }}
                        >
                          <span className="sr-only">{milestone.name}</span>
                        </span>
                      ))}
                  </div>
                </div>
              );
            })}
            <div className="cloud-roadmap-today" aria-hidden="true">
              <span className="cloud-roadmap-corner" />
              <div className="cloud-roadmap-track">
                <span style={{ left: position(now) }} />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
