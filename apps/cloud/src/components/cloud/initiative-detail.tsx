"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, CalendarRange } from "lucide-react";
import { MarkdownContent } from "@machdoch/client-ui/conversation/markdown-content";
import type {
  CloudProjectProgress,
  CloudWorkspace,
} from "@/lib/cloud-contract";
import {
  initiativeStatusLabels,
  type CloudInitiative,
} from "@/lib/cloud-initiative-contract";
import type { CloudProjectUpdate } from "@/lib/cloud-project-update-contract";
import { Button } from "@/components/ui/button";
import { InitiativeDialog } from "./initiative-dialog";
import { initiativeProgress } from "./initiative-list";
import { PersonAvatar } from "./person-avatar";
import { HealthLabel, ProgressRing, ProjectTable } from "./project-table";

const longDate = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function InitiativeDetail({
  initiative,
  workspace,
  progress,
  updates,
  initiatives,
}: {
  initiative: CloudInitiative;
  workspace: CloudWorkspace;
  progress: CloudProjectProgress[];
  updates: CloudProjectUpdate[];
  initiatives: CloudInitiative[];
}) {
  const [editing, setEditing] = useState(false);
  const writable = workspace.actor.role !== "viewer";
  const owner = workspace.members.find(
    (member) => member.id === initiative.ownerId,
  );
  const projects = workspace.projects.filter((project) =>
    initiative.projectIds.includes(project.id),
  );
  const percent = initiativeProgress(initiative);
  return (
    <>
      <header className="cloud-page-header">
        <div>
          <Link className="cloud-back-link" href="/cloud/initiatives">
            <ArrowLeft size={14} aria-hidden="true" /> Initiatives
          </Link>
          <h1>{initiative.name}</h1>
        </div>
        {writable && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            Edit initiative
          </Button>
        )}
      </header>
      <div className="cloud-project-page">
        <div className="cloud-project-main">
          {initiative.description && (
            <MarkdownContent
              className="cloud-project-summary"
              content={initiative.description}
            />
          )}
          {projects.length ? (
            <ProjectTable
              projects={projects}
              workspace={workspace}
              progress={progress}
              updates={updates}
              initiatives={initiatives}
              writable={writable}
            />
          ) : (
            <div className="cloud-empty">
              <p>No projects in this initiative.</p>
            </div>
          )}
        </div>
        <aside className="cloud-project-side" aria-label="Initiative details">
          <section className="cloud-card">
            <dl className="cloud-task-properties">
              <div>
                <dt>Status</dt>
                <dd className="cloud-initiative-status">
                  <span data-status={initiative.status}>
                    {initiativeStatusLabels[initiative.status]}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Health</dt>
                <dd>
                  <HealthLabel health={initiative.health} />
                </dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd className="cloud-project-progress-cell">
                  <ProgressRing percent={percent} />
                  {percent}% · {initiative.completedIssues} of{" "}
                  {initiative.issues} issues
                </dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd className="cloud-assignee">
                  {owner ? (
                    <>
                      <PersonAvatar
                        name={owner.name}
                        className="cloud-avatar-small"
                      />
                      {owner.name}
                    </>
                  ) : (
                    "No owner"
                  )}
                </dd>
              </div>
              {initiative.targetOn && (
                <div>
                  <dt>Target date</dt>
                  <dd className="cloud-assignee">
                    <CalendarRange size={13} aria-hidden="true" />
                    {longDate.format(
                      new Date(`${initiative.targetOn}T00:00:00Z`),
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </section>
        </aside>
      </div>
      {editing && (
        <InitiativeDialog
          open
          onOpenChange={setEditing}
          workspace={workspace}
          initiative={initiative}
        />
      )}
    </>
  );
}
