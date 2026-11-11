"use client";

import Link from "next/link";
import type {
  CloudProject,
  CloudProjectProgress,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import {
  projectHealthLabels,
  type CloudProjectUpdate,
  type ProjectHealth as HealthValue,
} from "@/lib/cloud-project-update-contract";
import type { CloudInitiative } from "@/lib/cloud-initiative-contract";
import { PersonAvatar } from "./person-avatar";
import { RelativeTime } from "./relative-time";
import { ProjectEditor } from "./project-editor";
import { projectStatusLabels, projectStatusStates } from "./project-fields";

const targetFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export const projectTabs = {
  all: { label: "All projects", statuses: null },
  active: { label: "Active", statuses: ["planned", "active", "paused"] },
  backlog: { label: "Backlog", statuses: ["backlog"] },
  closed: { label: "Closed", statuses: ["completed", "canceled"] },
} as const satisfies Record<
  string,
  { label: string; statuses: readonly CloudProject["status"][] | null }
>;
export type ProjectTab = keyof typeof projectTabs;

export function ProgressRing({ percent }: { percent: number }) {
  const circumference = 2 * Math.PI * 6;
  return (
    <svg
      className="cloud-progress-ring"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <circle className="cloud-progress-track" cx="8" cy="8" r="6" />
      {percent > 0 && (
        <circle
          className="cloud-progress-value"
          cx="8"
          cy="8"
          r="6"
          strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
        />
      )}
    </svg>
  );
}

export function ProjectHealth({
  update,
}: {
  update: CloudProjectUpdate | undefined;
}) {
  if (!update) return <span className="cloud-project-health">No updates</span>;
  return (
    <span className="cloud-project-health" data-health={update.health}>
      <span aria-hidden="true" />
      {projectHealthLabels[update.health]}
      <RelativeTime value={update.createdAt} compact prefix="· " />
    </span>
  );
}

export function HealthLabel({ health }: { health: HealthValue | null }) {
  return health ? (
    <span className="cloud-project-health" data-health={health}>
      <span aria-hidden="true" />
      {projectHealthLabels[health]}
    </span>
  ) : (
    <span className="cloud-project-health">No updates</span>
  );
}

export function ProjectTable({
  projects,
  workspace,
  progress,
  updates,
  initiatives,
  writable,
}: {
  projects: CloudProject[];
  workspace: CloudWorkspace;
  progress: CloudProjectProgress[];
  updates: CloudProjectUpdate[];
  initiatives: CloudInitiative[];
  writable: boolean;
}) {
  const teams = workspace.teams.filter((team) =>
    projects.some((project) => project.teamId === team.id),
  );
  return (
    <div className="cloud-project-table" role="table" aria-label="Projects">
      <div className="cloud-project-row cloud-project-head" role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader">Health</span>
        <span role="columnheader">Initiatives</span>
        <span role="columnheader">Lead</span>
        <span role="columnheader">Target date</span>
        <span role="columnheader">Issues</span>
        <span role="columnheader">Status</span>
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>
      {teams.map((team) => {
        const entries = projects.filter(
          (project) => project.teamId === team.id,
        );
        return (
          <div role="rowgroup" key={team.id}>
            <div className="cloud-project-group" role="row">
              <span role="cell">
                <span className="cloud-team-key" aria-hidden="true">
                  {team.key.slice(0, 2)}
                </span>
                {team.name}
                <span className="cloud-count">{entries.length}</span>
              </span>
            </div>
            {entries.map((project) => {
              const counts = progress.find(
                (entry) => entry.projectId === project.id,
              );
              const percent =
                counts && counts.total
                  ? Math.round((counts.completed / counts.total) * 100)
                  : 0;
              const lead = workspace.members.find(
                (member) => member.id === project.leadId,
              );
              return (
                <div
                  className="cloud-project-row"
                  role="row"
                  key={project.id}
                  id={`planning-${project.id}`}
                >
                  <span role="cell" className="cloud-project-name">
                    <span
                      className="cloud-state"
                      data-state={projectStatusStates[project.status]}
                      aria-hidden="true"
                    />
                    <Link
                      href={`/cloud/projects/${project.id}`}
                      prefetch={false}
                    >
                      {project.name}
                    </Link>
                  </span>
                  <span role="cell">
                    <ProjectHealth
                      update={updates.find(
                        (entry) => entry.projectId === project.id,
                      )}
                    />
                  </span>
                  <span role="cell" className="cloud-project-initiatives">
                    {initiatives
                      .filter((initiative) =>
                        initiative.projectIds.includes(project.id),
                      )
                      .map((initiative) => (
                        <Link
                          key={initiative.id}
                          href={`/cloud/initiatives/${initiative.id}`}
                          prefetch={false}
                        >
                          {initiative.name}
                        </Link>
                      ))}
                  </span>
                  <span role="cell">
                    {lead ? (
                      <span title={lead.name}>
                        <PersonAvatar
                          name={lead.name}
                          className="cloud-avatar-small"
                        />
                        <span className="sr-only">{lead.name}</span>
                      </span>
                    ) : (
                      <span
                        className="cloud-avatar-empty"
                        aria-label="No lead"
                      />
                    )}
                  </span>
                  <span role="cell" className="cloud-project-muted">
                    {project.targetOn
                      ? targetFormat.format(new Date(project.targetOn))
                      : ""}
                  </span>
                  <span role="cell" className="cloud-project-muted">
                    {counts?.total ?? 0}
                  </span>
                  <span
                    role="cell"
                    className="cloud-project-progress-cell"
                    title={`${projectStatusLabels[project.status]} · ${counts?.completed ?? 0} of ${counts?.total ?? 0} completed`}
                  >
                    <ProgressRing percent={percent} />
                    {percent}%
                  </span>
                  <span role="cell" className="cloud-project-actions">
                    {writable && (
                      <ProjectEditor
                        id={project.id}
                        members={workspace.members}
                      />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
