"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { CloudIssue, CloudWorkspace } from "@/lib/cloud-contract";
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
}: {
  workspace: CloudWorkspace;
  teamId?: string;
  projectId?: string;
  cycleId?: string;
  parent?: CloudIssue;
  onCreated?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const sender = useRef(createCommandSender());
  const router = useRouter();
  if (workspace.actor.role === "viewer" || !workspace.teams.length) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus />
        {parent ? "New sub-issue" : "New issue"}
      </Button>
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
          const input = {
            teamId: selectedTeam,
            title: formText(form, "title"),
            description: formText(form, "description"),
            projectId: workspace.projects.some(
              (project) =>
                project.id === projectId && project.teamId === selectedTeam,
            )
              ? projectId
              : null,
            cycleId: workspace.cycles.some(
              (cycle) => cycle.id === cycleId && cycle.teamId === selectedTeam,
            )
              ? cycleId
              : null,
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
