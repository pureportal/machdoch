"use client";

import { useRouter } from "next/navigation";
import { useRef } from "react";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import {
  initiativeStatusLabels,
  initiativeStatuses,
  type CloudInitiative,
} from "@/lib/cloud-initiative-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createCommandSender, formReference, formText } from "./api-client";

export function InitiativeDialog({
  open,
  onOpenChange,
  workspace,
  initiative,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: CloudWorkspace;
  initiative?: CloudInitiative;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) sender.current = createCommandSender();
      }}
      title={initiative ? "Edit initiative" : "New initiative"}
      submitLabel={initiative ? "Save initiative" : "Create initiative"}
      onSubmit={async (form) => {
        const input = {
          name: formText(form, "name"),
          description: formText(form, "description"),
          status: formText(form, "status"),
          ownerId: formReference(form, "ownerId"),
          targetOn: formReference(form, "targetOn"),
          projectIds: form.getAll("projectIds").map(String),
        };
        const result = initiative
          ? await sender.current<{ id: string }>(
              `initiatives/${initiative.id}`,
              { ...input, revision: initiative.revision },
              "PATCH",
            )
          : await sender.current<{ id: string }>("initiatives", input);
        sender.current = createCommandSender();
        if (initiative) router.refresh();
        else router.push(`/cloud/initiatives/${result.id}`);
      }}
    >
      <Field label="Name" htmlFor="initiative-name">
        <Input
          id="initiative-name"
          name="name"
          defaultValue={initiative?.name}
          maxLength={120}
          required
          autoFocus
        />
      </Field>
      <Field label="Description" htmlFor="initiative-description">
        <Textarea
          id="initiative-description"
          name="description"
          defaultValue={initiative?.description}
          maxLength={20000}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Status" htmlFor="initiative-status">
          <Select
            id="initiative-status"
            name="status"
            defaultValue={initiative?.status ?? "planned"}
          >
            {initiativeStatuses.map((status) => (
              <option key={status} value={status}>
                {initiativeStatusLabels[status]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Owner" htmlFor="initiative-owner">
          <Select
            id="initiative-owner"
            name="ownerId"
            defaultValue={initiative?.ownerId ?? ""}
          >
            <option value="">No owner</option>
            {workspace.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Target date" htmlFor="initiative-target">
          <Input
            id="initiative-target"
            name="targetOn"
            type="date"
            defaultValue={initiative?.targetOn ?? ""}
          />
        </Field>
      </div>
      {workspace.projects.length > 0 && (
        <fieldset className="cloud-initiative-projects">
          <legend>Projects</legend>
          {workspace.projects.map((project) => (
            <label key={project.id}>
              <input
                type="checkbox"
                name="projectIds"
                value={project.id}
                defaultChecked={initiative?.projectIds.includes(project.id)}
              />
              {project.name}
            </label>
          ))}
        </fieldset>
      )}
    </FormDialog>
  );
}
