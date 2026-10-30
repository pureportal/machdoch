import Link from "next/link";
import { ArrowUpRight, CalendarRange, LockKeyhole, Users } from "lucide-react";
import type {
  CloudCycle,
  CloudProject,
  CloudProjectProgress,
  CloudTeam,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import { PersonAvatar } from "./person-avatar";
import { projectStatusLabels, projectStatusStates } from "./project-fields";
import { Button } from "@/components/ui/button";
import { ProjectEditor } from "./project-editor";
import { TeamEditor } from "./team-editor";
import { EstimateScaleEditor } from "./scale-editor";
import { LabelManager } from "./label-manager";
import { WorkflowEditor } from "./workflow-editor";
import { CycleDates } from "./cycle-dates";

const projectDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function ProjectDirectory({
  projects,
  workspace,
  progress,
  writable,
}: {
  projects: CloudProject[];
  workspace: CloudWorkspace;
  progress: CloudProjectProgress[];
  writable: boolean;
}) {
  return (
    <ul className="cloud-project-directory" aria-label="Projects">
      {projects.map((project) => {
        const counts = progress.find((entry) => entry.projectId === project.id);
        const percent =
          counts && counts.total
            ? Math.round((counts.completed / counts.total) * 100)
            : 0;
        const lead = workspace.members.find(
          (member) => member.id === project.leadId,
        );
        const team = workspace.teams.find(
          (entry) => entry.id === project.teamId,
        );
        return (
          <li key={project.id} id={`planning-${project.id}`}>
            <span
              className="cloud-state cloud-project-status"
              data-state={projectStatusStates[project.status]}
              title={projectStatusLabels[project.status]}
            >
              <span className="sr-only">
                {projectStatusLabels[project.status]}
              </span>
            </span>
            <div className="cloud-project-description">
              <h2>
                <Link href={`/cloud/issues?projectId=${project.id}`}>
                  {project.name}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              </h2>
              {project.description && <p>{project.description}</p>}
            </div>
            <div
              className="cloud-project-progress"
              title={`${counts?.completed ?? 0} of ${counts?.total ?? 0} issues completed`}
            >
              <span
                className="cloud-project-progress-track"
                role="progressbar"
                aria-label={`${project.name} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span style={{ width: `${percent}%` }} />
              </span>
              <span>{percent}%</span>
            </div>
            <span
              className="cloud-project-lead"
              title={lead?.name ?? "No lead"}
            >
              {lead ? (
                <PersonAvatar name={lead.name} />
              ) : (
                <span className="cloud-avatar-empty" />
              )}
              <span className="sr-only">{lead?.name ?? "No lead"}</span>
            </span>
            <span className="cloud-project-target">
              {project.targetOn ? (
                <>
                  <CalendarRange size={13} aria-hidden="true" />
                  {projectDate.format(new Date(project.targetOn))}
                </>
              ) : null}
            </span>
            <Link
              className="cloud-directory-team"
              href={`/cloud/issues?teamId=${project.teamId}`}
            >
              <Users size={14} aria-hidden="true" />
              {team?.name}
            </Link>
            {writable && (
              <div className="cloud-directory-actions">
                <ProjectEditor id={project.id} members={workspace.members} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function TeamDirectory({
  teams,
  workspace,
}: {
  teams: CloudTeam[];
  workspace: CloudWorkspace;
}) {
  const admin = ["owner", "admin"].includes(workspace.actor.role);
  return (
    <div className="cloud-team-directory">
      {teams.map((team) => (
        <section
          className="cloud-card cloud-team-card"
          key={team.id}
          id={`planning-${team.id}`}
        >
          <header>
            <span className="cloud-team-key" aria-hidden="true">
              {team.key}
            </span>
            <div>
              <h2>
                <Link href={`/cloud/issues?teamId=${team.id}`}>
                  {team.name}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              </h2>
              <span className="cloud-directory-team">
                {team.visibility === "private" ? (
                  <>
                    <LockKeyhole size={12} aria-hidden="true" />
                    Private
                  </>
                ) : (
                  <>
                    <Users size={12} aria-hidden="true" />
                    Organization
                  </>
                )}
              </span>
            </div>
          </header>
          <dl className="cloud-team-stats">
            <div>
              <dt>Projects</dt>
              <dd>
                {
                  workspace.projects.filter(
                    (project) => project.teamId === team.id,
                  ).length
                }
              </dd>
            </div>
            <div>
              <dt>Active cycles</dt>
              <dd>
                {
                  workspace.cycles.filter(
                    (cycle) =>
                      cycle.teamId === team.id && cycle.status === "active",
                  ).length
                }
              </dd>
            </div>
            <div>
              <dt>Planned cycles</dt>
              <dd>
                {
                  workspace.cycles.filter(
                    (cycle) =>
                      cycle.teamId === team.id && cycle.status === "planned",
                  ).length
                }
              </dd>
            </div>
          </dl>
          <div className="cloud-card-actions">
            {admin && <TeamEditor team={team} workspace={workspace} />}
            {admin && <EstimateScaleEditor team={team} />}
            <LabelManager
              teamId={team.id}
              writable={workspace.actor.role !== "viewer"}
            />
            {admin && <WorkflowEditor teamId={team.id} />}
          </div>
        </section>
      ))}
    </div>
  );
}

export function CycleDirectory({
  cycles,
  teams,
}: {
  cycles: CloudCycle[];
  teams: CloudTeam[];
}) {
  return (
    <div className="cloud-cycle-directory">
      {(["active", "planned", "closed"] as const).map((status) => {
        const entries = cycles
          .filter((cycle) => cycle.status === status)
          .sort((a, b) =>
            status === "closed"
              ? b.startsOn.localeCompare(a.startsOn)
              : a.startsOn.localeCompare(b.startsOn),
          );
        return (
          entries.length > 0 && (
            <section key={status} aria-label={`${status} cycles`}>
              <h2 className="cloud-cycle-group-heading">
                <span className="cloud-cycle-status" data-status={status}>
                  {status}
                </span>
                <span className="cloud-count">{entries.length}</span>
              </h2>
              <div className="cloud-cycle-timeline">
                {entries.map((cycle) => (
                  <article
                    className="cloud-cycle-entry"
                    key={cycle.id}
                    id={`planning-${cycle.id}`}
                    data-status={status}
                  >
                    <div className="cloud-cycle-calendar" aria-hidden="true">
                      <span>
                        {new Date(
                          `${cycle.startsOn}T12:00:00Z`,
                        ).toLocaleDateString("en", {
                          month: "short",
                          timeZone: "UTC",
                        })}
                      </span>
                      <strong>{Number(cycle.startsOn.slice(-2))}</strong>
                    </div>
                    <div className="cloud-cycle-entry-body">
                      <h3>
                        <Link href={`/cloud/cycles/${cycle.id}`}>
                          {cycle.name}
                        </Link>
                      </h3>
                      <span className="cloud-directory-team">
                        <CalendarRange size={14} aria-hidden="true" />
                        <CycleDates cycle={cycle} />
                      </span>
                      <span className="cloud-directory-team">
                        <Users size={14} aria-hidden="true" />
                        {teams.find((team) => team.id === cycle.teamId)?.name}
                      </span>
                    </div>
                    {cycle.capacity !== null && (
                      <dl className="cloud-cycle-entry-capacity">
                        <dt>Capacity</dt>
                        <dd>
                          {cycle.capacity}
                          <span> points</span>
                        </dd>
                      </dl>
                    )}
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/cloud/cycles/${cycle.id}`}>
                        Open cycle
                        <ArrowUpRight />
                      </Link>
                    </Button>
                  </article>
                ))}
              </div>
            </section>
          )
        );
      })}
    </div>
  );
}
