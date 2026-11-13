"use client";

import { holderCan } from "@/lib/cloud-permissions";
import Link from "next/link";
import { useState } from "react";
import { Plus, Target } from "lucide-react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  initiativeStatusLabels,
  type CloudInitiative,
} from "@/lib/cloud-initiative-contract";
import { Button } from "@/components/ui/button";
import { InitiativeDialog } from "./initiative-dialog";
import { PersonAvatar } from "./person-avatar";
import { HealthLabel, ProgressRing } from "./project-table";

const targetFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function initiativeProgress(initiative: CloudInitiative): number {
  return initiative.issues
    ? Math.round((initiative.completedIssues / initiative.issues) * 100)
    : 0;
}

export function InitiativeList({
  initiatives,
  workspace,
}: {
  initiatives: CloudInitiative[];
  workspace: CloudWorkspace;
}) {
  const [open, setOpen] = useState(false);
  const writable = holderCan(workspace.actor, "planning.edit");
  return (
    <>
      <header className="cloud-page-header">
        <h1>Initiatives</h1>
        {writable && (
          <Button onClick={() => setOpen(true)}>
            <Plus />
            New initiative
          </Button>
        )}
      </header>
      {!initiatives.length ? (
        <div className="cloud-empty">
          <Target aria-hidden="true" />
          <p>No initiatives yet.</p>
        </div>
      ) : (
        <div
          className="cloud-project-table cloud-initiative-table"
          role="table"
          aria-label="Initiatives"
        >
          <div className="cloud-project-row cloud-project-head" role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Health</span>
            <span role="columnheader">Owner</span>
            <span role="columnheader">Projects</span>
            <span role="columnheader">Target date</span>
            <span role="columnheader">Progress</span>
            <span role="columnheader">Status</span>
          </div>
          {initiatives.map((initiative) => {
            const owner = workspace.members.find(
              (member) => member.id === initiative.ownerId,
            );
            const percent = initiativeProgress(initiative);
            return (
              <div className="cloud-project-row" role="row" key={initiative.id}>
                <span role="cell" className="cloud-project-name">
                  <Target size={14} aria-hidden="true" />
                  <Link
                    href={`/cloud/initiatives/${initiative.id}`}
                    prefetch={false}
                  >
                    {initiative.name}
                  </Link>
                </span>
                <span role="cell">
                  <HealthLabel health={initiative.health} />
                </span>
                <span role="cell">
                  {owner ? (
                    <span title={owner.name}>
                      <PersonAvatar
                        name={owner.name}
                        className="cloud-avatar-small"
                      />
                      <span className="sr-only">{owner.name}</span>
                    </span>
                  ) : (
                    <span
                      className="cloud-avatar-empty"
                      aria-label="No owner"
                    />
                  )}
                </span>
                <span role="cell" className="cloud-project-muted">
                  {initiative.projectIds.length}
                </span>
                <span role="cell" className="cloud-project-muted">
                  {initiative.targetOn
                    ? targetFormat.format(new Date(initiative.targetOn))
                    : ""}
                </span>
                <span role="cell" className="cloud-project-progress-cell">
                  <ProgressRing percent={percent} />
                  {percent}%
                </span>
                <span role="cell" className="cloud-initiative-status">
                  <span data-status={initiative.status}>
                    {initiativeStatusLabels[initiative.status]}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <InitiativeDialog
        open={open}
        onOpenChange={setOpen}
        workspace={workspace}
      />
    </>
  );
}
