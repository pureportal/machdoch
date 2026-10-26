"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CloudTeam, CloudWorkspace } from "@/lib/cloud-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cloudRequest, createCommandSender, formText } from "./api-client";

export function TeamEditor({
  team,
  workspace,
}: {
  team: CloudTeam;
  workspace: CloudWorkspace;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  const [memberIds, setMemberIds] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError("");
          sender.current = createCommandSender();
          void cloudRequest<{ memberIds: string[] }>(`teams/${team.id}/members`)
            .then((result) => setMemberIds(result.memberIds))
            .catch((reason: Error) => setError(reason.message))
            .finally(() => setPending(false));
        }}
      >
        {pending ? "Opening…" : "Edit team"}
      </Button>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <FormDialog
        open={memberIds !== null}
        onOpenChange={(open) => {
          if (!open) setMemberIds(null);
        }}
        title="Edit team"
        submitLabel="Save team"
        onSubmit={async (form) => {
          await sender.current(
            `teams/${team.id}`,
            {
              revision: team.revision,
              name: formText(form, "name"),
              visibility: formText(form, "visibility"),
              memberIds: form.getAll("memberIds"),
            },
            "PATCH",
          );
          router.refresh();
        }}
      >
        <Field label="Name" htmlFor={`team-name-${team.id}`}>
          <Input
            id={`team-name-${team.id}`}
            name="name"
            required
            maxLength={120}
            defaultValue={team.name}
          />
        </Field>
        <Field label="Visibility" htmlFor={`team-visibility-${team.id}`}>
          <Select
            id={`team-visibility-${team.id}`}
            name="visibility"
            defaultValue={team.visibility}
          >
            <option value="organization">Organization</option>
            <option value="private">Private</option>
          </Select>
        </Field>
        <fieldset className="cloud-member-picker">
          <legend>Members</legend>
          {workspace.members.map((member) => (
            <label key={member.id}>
              <input
                type="checkbox"
                name="memberIds"
                value={member.id}
                defaultChecked={memberIds?.includes(member.id)}
              />
              <span>{member.name}</span>
            </label>
          ))}
        </fieldset>
      </FormDialog>
    </>
  );
}
