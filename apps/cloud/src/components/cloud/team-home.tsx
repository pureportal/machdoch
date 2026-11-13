"use client";

import Link from "next/link";
import {
  ArrowLeft,
  CalendarRange,
  Columns3,
  LayoutList,
  LockKeyhole,
  Users,
} from "lucide-react";
import { holderCan } from "@/lib/cloud-permissions";
import type {
  CloudCycle,
  CloudIssueSummary,
  CloudProjectProgress,
  CloudTeam,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import type { CycleBurnupPoint } from "@/lib/cloud-cycle-contract";
import type { CloudProjectUpdate } from "@/lib/cloud-project-update-contract";
import type { CloudTeamHome } from "@/lib/cloud-team-contract";
import { projectStatusLabels, projectStatusStates } from "@/lib/project-status";
import { Button } from "@/components/ui/button";
import { CycleBurnupChart } from "./cycle-burnup-chart";
import { CycleDates } from "./cycle-dates";
import { IssueBreakdownCard } from "./issue-breakdown-card";
import { CreateIssue } from "./issue-form";
import { StateIcon } from "./issue-properties";
import { PersonAvatar } from "./person-avatar";
import { ProgressRing, ProjectHealth } from "./project-table";
import { RelativeTime } from "./relative-time";
import { TeamResources } from "./team-resources";
import { UpdateAuthor } from "./update-author";

const recentIssues = 8;

function percent(done: number, total: number): number {
  return total ? Math.round((done / total) * 100) : 0;
}

export function TeamHome({
  team,
  home,
  issues,
  progress,
  updates,
  cycle,
  burnup,
  workspace,
}: {
  team: CloudTeam;
  home: CloudTeamHome;
  issues: CloudIssueSummary[];
  progress: CloudProjectProgress[];
  updates: CloudProjectUpdate[];
  cycle: CloudCycle | null;
  burnup: CycleBurnupPoint[];
  workspace: CloudWorkspace;
}) {
  const projects = workspace.projects.filter(
    (project) =>
      project.teamId === team.id &&
      !["completed", "canceled"].includes(project.status),
  );
  const members = home.memberIds.length
    ? workspace.members.filter((member) => home.memberIds.includes(member.id))
    : workspace.members;
  const open = issues.filter(
    (issue) => !["complete", "canceled"].includes(issue.state),
  );
  const cycleIssues = cycle
    ? issues.filter((issue) => issue.cycleId === cycle.id)
    : [];
  const cycleDone = cycleIssues.filter(
    (issue) => issue.state === "complete",
  ).length;
  const recent = [...open]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, recentIssues);
  const teamUpdates = updates
    .filter((update) =>
      projects.some((project) => project.id === update.projectId),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return (
    <>
      <header className="cloud-page-header">
        <div>
          <Link className="cloud-back-link" href="/cloud/teams">
            <ArrowLeft size={14} aria-hidden="true" /> Teams
          </Link>
          <h1 className="cloud-team-home-title">
            <span className="cloud-team-key" aria-hidden="true">
              {team.key}
            </span>
            {team.name}
          </h1>
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
            <span>· {open.length} open issues</span>
          </span>
        </div>
        <div className="cloud-editor-actions">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/cloud/issues?teamId=${team.id}`}>
              <LayoutList />
              Issues
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/cloud/issues?teamId=${team.id}&view=board`}>
              <Columns3 />
              Board
            </Link>
          </Button>
          {holderCan(workspace.actor, "issues.edit") && (
            <CreateIssue workspace={workspace} teamId={team.id} />
          )}
        </div>
      </header>
      <div className="cloud-team-home">
        <div className="cloud-team-home-main">
          {cycle && (
            <section
              className="cloud-team-section"
              aria-labelledby="team-cycle"
            >
              <header>
                <h2 id="team-cycle">
                  <Link href={`/cloud/cycles/${cycle.id}`}>{cycle.name}</Link>
                </h2>
                <span className="cloud-team-meta">
                  <CalendarRange size={13} aria-hidden="true" />
                  <CycleDates cycle={cycle} />
                  <span>
                    {cycleDone} / {cycleIssues.length} done ·{" "}
                    {percent(cycleDone, cycleIssues.length)}%
                  </span>
                </span>
              </header>
              <CycleBurnupChart cycle={cycle} points={burnup} />
            </section>
          )}
          <section
            className="cloud-team-section"
            aria-labelledby="team-projects"
          >
            <header>
              <h2 id="team-projects">Projects</h2>
              <Link
                className="cloud-team-more"
                href={`/cloud/projects?teamId=${team.id}`}
              >
                All projects
              </Link>
            </header>
            {!projects.length ? (
              <p className="cloud-empty-inline">No active projects.</p>
            ) : (
              <ul className="cloud-team-list">
                {projects.map((project) => {
                  const entry = progress.find(
                    (item) => item.projectId === project.id,
                  );
                  const done = percent(
                    entry?.completed ?? 0,
                    entry?.total ?? 0,
                  );
                  return (
                    <li key={project.id}>
                      <ProgressRing percent={done} />
                      <Link href={`/cloud/projects/${project.id}`}>
                        {project.name}
                      </Link>
                      <span
                        className="cloud-state"
                        data-state={projectStatusStates[project.status]}
                      >
                        {projectStatusLabels[project.status]}
                      </span>
                      <ProjectHealth
                        update={updates.find(
                          (update) => update.projectId === project.id,
                        )}
                      />
                      <span className="cloud-team-percent">{done}%</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="cloud-team-section" aria-labelledby="team-recent">
            <header>
              <h2 id="team-recent">Recently updated</h2>
              <Link
                className="cloud-team-more"
                href={`/cloud/issues?teamId=${team.id}&sort=updated`}
              >
                All issues
              </Link>
            </header>
            {!recent.length ? (
              <p className="cloud-empty-inline">No open issues.</p>
            ) : (
              <ul className="cloud-team-list">
                {recent.map((issue) => {
                  const assignee = workspace.members.find(
                    (member) => member.id === issue.assigneeId,
                  );
                  return (
                    <li key={issue.id}>
                      <StateIcon state={issue.state} />
                      <span className="cloud-issue-key">
                        {issue.identifier}
                      </span>
                      <Link href={`/cloud/issues/${issue.id}`}>
                        {issue.title}
                      </Link>
                      {assignee && (
                        <PersonAvatar
                          name={assignee.name}
                          className="cloud-avatar-tiny"
                        />
                      )}
                      <RelativeTime value={issue.updatedAt} compact />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {teamUpdates.length > 0 && (
            <section
              className="cloud-team-section"
              aria-labelledby="team-updates"
            >
              <header>
                <h2 id="team-updates">Latest updates</h2>
                <Link className="cloud-team-more" href="/cloud/pulse">
                  Pulse
                </Link>
              </header>
              <ul className="cloud-team-updates">
                {teamUpdates.map((update) => (
                  <li key={update.id}>
                    <header>
                      <span
                        className="cloud-project-health"
                        data-health={update.health}
                      >
                        <span aria-hidden="true" />
                      </span>
                      <Link href={`/cloud/projects/${update.projectId}`}>
                        {
                          projects.find(
                            (project) => project.id === update.projectId,
                          )?.name
                        }
                      </Link>
                      <UpdateAuthor update={update} />
                      <RelativeTime value={update.createdAt} />
                    </header>
                    <p>
                      {update.summary ||
                        update.body.split("\n").find((line) => line.trim())}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <aside className="cloud-team-home-side" aria-label="Team details">
          <section
            className="cloud-card cloud-team-section"
            aria-labelledby="team-members"
          >
            <header>
              <h2 id="team-members">
                Members<span className="cloud-count">{members.length}</span>
              </h2>
            </header>
            <ul className="cloud-team-members">
              {members.map((member) => (
                <li key={member.id}>
                  <PersonAvatar
                    name={member.name}
                    className="cloud-avatar-small"
                  />
                  <span>{member.name}</span>
                </li>
              ))}
            </ul>
          </section>
          <TeamResources
            teamId={team.id}
            resources={home.resources}
            writable={holderCan(workspace.actor, "planning.edit")}
          />
          <IssueBreakdownCard issues={issues} workspace={workspace} />
        </aside>
      </div>
    </>
  );
}
