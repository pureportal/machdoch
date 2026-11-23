"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  savedViewIcons,
  type SavedView,
  type SavedViewIcon,
  type SavedViewInput,
  type SavedViewScope,
} from "@/lib/cloud-view-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createCommandSender, formText } from "./api-client";

const scopeLabels: Record<SavedViewScope, string> = {
  personal: "Only me",
  team: "Team",
  workspace: "Workspace",
};

export function SaveViewDialog({
  open,
  onOpenChange,
  filters,
  writable,
  teams,
  defaultTeamId,
  view,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: SavedViewInput["filters"];
  writable: boolean;
  teams: { id: string; name: string }[];
  defaultTeamId?: string | null;
  view?: SavedView;
  onSaved?: (id: string) => void;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  const [scope, setScope] = useState<SavedViewScope>(
    view?.scope ?? "personal",
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) sender.current = createCommandSender();
      }}
      title={view ? "Edit view" : "Save view"}
      submitLabel={view ? "Save" : "Save view"}
      onSubmit={async (form) => {
        const input: SavedViewInput = {
          name: formText(form, "name"),
          description: formText(form, "description"),
          icon: formText(form, "icon") as SavedViewIcon,
          scope,
          teamId: scope === "team" ? formText(form, "teamId") : null,
          filters,
        };
        const saved = await sender.current<{ id: string }>(
          view ? `views/${view.id}` : "views",
          input,
          view ? "PATCH" : "POST",
        );
        onSaved?.(saved.id);
        router.refresh();
      }}
    >
      <Field label="Name" htmlFor="view-name">
        <Input
          id="view-name"
          name="name"
          maxLength={80}
          required
          autoFocus
          defaultValue={view?.name}
        />
      </Field>
      <Field label="Description" htmlFor="view-description">
        <Textarea
          id="view-description"
          name="description"
          maxLength={500}
          rows={2}
          defaultValue={view?.description}
        />
      </Field>
      <Field label="Icon" htmlFor="view-icon">
        <Select
          id="view-icon"
          name="icon"
          defaultValue={view?.icon ?? "bookmark"}
        >
          {savedViewIcons.map((icon) => (
            <option key={icon} value={icon}>
              {icon[0]!.toUpperCase() + icon.slice(1)}
            </option>
          ))}
        </Select>
      </Field>
      {writable && (
        <Field label="Visible to" htmlFor="view-scope">
          <Select
            id="view-scope"
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as SavedViewScope)
            }
          >
            {(Object.keys(scopeLabels) as SavedViewScope[])
              .filter((entry) => entry !== "team" || teams.length > 0)
              .map((entry) => (
                <option key={entry} value={entry}>
                  {scopeLabels[entry]}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {writable && scope === "team" && (
        <Field label="Team" htmlFor="view-team">
          <Select
            id="view-team"
            name="teamId"
            defaultValue={view?.teamId ?? defaultTeamId ?? teams[0]?.id}
          >
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </FormDialog>
  );
}
