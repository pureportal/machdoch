"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
import type { IssueChangeSet } from "@/lib/cloud-issue-changes-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { createCommandSender, formText } from "./api-client";

export function CreateIssue({
  workspace,
  teamId,
  projectId,
  cycleId,
  parent,
  onCreated,
  shortcut = false,
  autoOpen = false,
  defaults,
  compactLabel,
}: {
  workspace: CloudWorkspace;
  teamId?: string;
  projectId?: string;
  cycleId?: string;
  parent?: CloudIssue;
  onCreated?: () => Promise<void>;
  shortcut?: boolean;
  autoOpen?: boolean;
  defaults?: Pick<
    IssueChangeSet,
    "status" | "priority" | "assigneeId" | "projectId" | "cycleId"
  >;
  compactLabel?: string;
}) {
  const [open, setOpen] = useState(autoOpen);
  const sender = useRef(createCommandSender());
  const router = useRouter();
  const available =
    workspace.actor.role !== "viewer" && workspace.teams.length > 0;
  useEffect(() => {
    if (!shortcut || !available) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key.toLowerCase() !== "c" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.defaultPrevented ||
        target?.closest("input,textarea,select,[contenteditable],[role=dialog]")
      )
        return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcut, available]);
  if (!available) return null;
  return (
    <>
      {compactLabel ? (
        <button
          type="button"
          className="cloud-icon-button"
          aria-label={compactLabel}
          onClick={() => setOpen(true)}
        >
          <Plus size={14} />
        </button>
      ) : (
        <Button
          onClick={() => setOpen(true)}
          aria-keyshortcuts={shortcut ? "C" : undefined}
          title={shortcut ? "New issue (C)" : undefined}
        >
          <Plus />
          {parent ? "New sub-issue" : "New issue"}
        </Button>
      )}
      <FormDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) sender.current = createCommandSender();
        }}
        title={parent ? "New sub-issue" : "New issue"}
        submitLabel="Create issue"
        onSubmit={async (form) => {
          const selectedTeam = formText(form, "teamId");
          const targetProject = defaults?.projectId ?? projectId;
          const targetCycle = defaults?.cycleId ?? cycleId;
          const statusTeam = defaults?.status
            ? workspace.workflows.find((workflow) =>
                workflow.statuses.some(
                  (status) => status.id === defaults.status!.id,
                ),
              )?.teamId
            : undefined;
          const input = {
            teamId: selectedTeam,
            title: formText(form, "title"),
            description: formText(form, "description"),
            projectId: workspace.projects.some(
              (project) =>
                project.id === targetProject && project.teamId === selectedTeam,
            )
              ? targetProject
              : null,
            cycleId: workspace.cycles.some(
              (cycle) =>
                cycle.id === targetCycle && cycle.teamId === selectedTeam,
            )
              ? targetCycle
              : null,
            ...(defaults?.status && statusTeam === selectedTeam
              ? { status: defaults.status }
              : {}),
            ...(defaults?.priority ? { priority: defaults.priority } : {}),
            ...(defaults?.assigneeId
              ? { assigneeId: defaults.assigneeId }
              : {}),
          };
          const result = await sender.current<{ id: string }>(
            parent ? `issues/${parent.id}/children` : "issues",
            parent ? { parentRevision: parent.revision, issue: input } : input,
          );
          if (onCreated) await onCreated();
          else {
            router.push(`/cloud/issues/${result.id}`);
            router.refresh();
          }
        }}
      >
        <Field label="Team" htmlFor="issue-team">
          <Select
            id="issue-team"
            name="teamId"
            defaultValue={teamId ?? workspace.teams[0]?.id}
            required
          >
            {workspace.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" htmlFor="issue-title">
          <Input
            id="issue-title"
            name="title"
            maxLength={300}
            required
            autoFocus
          />
        </Field>
        <Field label="Description" htmlFor="issue-description">
          <Textarea
            id="issue-description"
            name="description"
            maxLength={30000}
          />
        </Field>
      </FormDialog>
    </>
  );
}
