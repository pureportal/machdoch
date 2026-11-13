"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import {
  projectHealthLabels,
  projectHealths,
  type CloudProjectUpdateEntry,
  type ProjectHealth,
} from "@/lib/cloud-project-update-contract";
import { Select } from "@/components/ui/select";
import { PulseInstructionsEditor } from "./pulse-instructions";
import { PulseWriter } from "./pulse-writer";
import { RelativeTime } from "./relative-time";
import { UpdateAuthor } from "./update-author";

const dayFormat = new Intl.DateTimeFormat("en", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const allValues = "";

function groupByDay(updates: CloudProjectUpdateEntry[]) {
  const groups: { day: string; updates: CloudProjectUpdateEntry[] }[] = [];
  for (const update of updates) {
    const day = update.createdAt.slice(0, 10);
    const group = groups.at(-1);
    if (group?.day === day) group.updates.push(update);
    else groups.push({ day, updates: [update] });
  }
  return groups;
}

function PulseEntry({ update }: { update: CloudProjectUpdateEntry }) {
  return (
    <li className="cloud-pulse-entry">
      <header>
        <span className="cloud-project-health" data-health={update.health}>
          <span aria-hidden="true" />
          {projectHealthLabels[update.health]}
        </span>
        <Link href={`/cloud/projects/${update.projectId}`}>
          {update.projectName}
        </Link>
        <UpdateAuthor update={update} />
        <RelativeTime value={update.createdAt} />
      </header>
      {update.summary && (
        <p className="cloud-update-summary">{update.summary}</p>
      )}
      {update.body &&
        (update.summary ? (
          <details className="cloud-pulse-details">
            <summary>Full update</summary>
            <MarkdownContent content={update.body} />
          </details>
        ) : (
          <MarkdownContent content={update.body} />
        ))}
    </li>
  );
}

export function PulseFeed({
  updates,
  teams,
  projects,
  writableProjects,
  canEditInstructions,
}: {
  updates: CloudProjectUpdateEntry[];
  teams: { id: string; name: string }[];
  projects: { id: string; name: string; teamId: string }[];
  writableProjects: { id: string; name: string }[];
  canEditInstructions: boolean;
}) {
  const [teamId, setTeamId] = useState(allValues);
  const [projectId, setProjectId] = useState(allValues);
  const [health, setHealth] = useState<ProjectHealth | null>(null);
  const scoped = useMemo(
    () =>
      updates.filter(
        (update) =>
          (!teamId || update.teamId === teamId) &&
          (!projectId || update.projectId === projectId),
      ),
    [updates, teamId, projectId],
  );
  const shown = health
    ? scoped.filter((update) => update.health === health)
    : scoped;
  const counts = Object.fromEntries(
    projectHealths.map((entry) => [
      entry,
      scoped.filter((update) => update.health === entry).length,
    ]),
  ) as Record<ProjectHealth, number>;
  const projectOptions = projects.filter(
    (project) =>
      (!teamId || project.teamId === teamId) &&
      updates.some((update) => update.projectId === project.id),
  );
  return (
    <>
      <header className="cloud-page-header">
        <h1>Pulse</h1>
        <div className="cloud-editor-actions">
          {canEditInstructions && <PulseInstructionsEditor />}
          {writableProjects.length > 0 && (
            <PulseWriter projects={writableProjects} />
          )}
        </div>
      </header>
      {!updates.length ? (
        <div className="cloud-empty">
          <Activity aria-hidden="true" />
          <p>No project updates yet.</p>
        </div>
      ) : (
        <div className="cloud-pulse">
          <div className="cloud-pulse-toolbar">
            <div
              className="cloud-pulse-health"
              role="group"
              aria-label="Project health"
            >
              {projectHealths.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  data-health={entry}
                  aria-pressed={health === entry}
                  onClick={() => setHealth(health === entry ? null : entry)}
                >
                  <span aria-hidden="true" />
                  {projectHealthLabels[entry]}
                  <strong>{counts[entry]}</strong>
                </button>
              ))}
            </div>
            {teams.length > 1 && (
              <Select
                aria-label="Team"
                value={teamId}
                onChange={(event) => {
                  setTeamId(event.target.value);
                  setProjectId(allValues);
                }}
              >
                <option value={allValues}>All teams</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </Select>
            )}
            {projectOptions.length > 1 && (
              <Select
                aria-label="Project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value={allValues}>All projects</option>
                {projectOptions.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          {!shown.length ? (
            <p className="cloud-empty-inline">No matching updates.</p>
          ) : (
            groupByDay(shown).map((group) => (
              <section key={group.day} aria-label={group.day}>
                <h2>{dayFormat.format(new Date(`${group.day}T12:00:00Z`))}</h2>
                <ol>
                  {group.updates.map((update) => (
                    <PulseEntry key={update.id} update={update} />
                  ))}
                </ol>
              </section>
            ))
          )}
        </div>
      )}
    </>
  );
}
