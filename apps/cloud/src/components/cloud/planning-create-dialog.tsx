"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  defaultEstimateScale,
  type CloudWorkspace,
} from "@/lib/cloud-contract";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { createCommandSender, formText } from "./api-client";
import {
  ProjectPlanningFields,
  initialProjectPlanning,
} from "./project-fields";

export function PlanningCreateDialog({
  kind,
  workspace,
  open,
  onOpenChange,
}: {
  kind: "teams" | "projects" | "cycles";
  workspace: CloudWorkspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sender = useRef(createCommandSender());
  const router = useRouter();
  const [planning, setPlanning] = useState(initialProjectPlanning);
  const labels = {
    single: { teams: "team", projects: "project", cycles: "cycle" }[kind],
  };
  return (
    <FormDialog
      title={`New ${labels.single}`}
      submitLabel={`Create ${labels.single}`}
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          sender.current = createCommandSender();
          setPlanning(initialProjectPlanning);
        }
      }}
      onSubmit={async (form) => {
        const name = formText(form, "name");
        let body: unknown;
        if (kind === "teams")
          body = {
            name,
            key: formText(form, "key"),
            visibility: formText(form, "visibility"),
            estimateScale: defaultEstimateScale,
          };
        else if (kind === "projects")
          body = {
            name,
            teamId: formText(form, "teamId"),
            description: formText(form, "description"),
            ...planning,
          };
        else
          body = {
            name,
            teamId: formText(form, "teamId"),
            startsOn: formText(form, "startsOn"),
            endsOn: formText(form, "endsOn"),
            timezone: formText(form, "timezone"),
            capacity:
              formText(form, "capacity") === ""
                ? null
                : Number(formText(form, "capacity")),
          };
        await sender.current(kind, body);
        router.refresh();
      }}
    >
      <Field label="Name" htmlFor="catalog-name">
        <Input name="name" id="catalog-name" required maxLength={120} />
      </Field>
      {kind === "teams" ? (
        <>
          <Field label="Issue prefix" htmlFor="catalog-key">
            <Input
              id="catalog-key"
              name="key"
              required
              minLength={2}
              maxLength={10}
              pattern="[A-Z][A-Z0-9]{1,9}"
              onInput={(event) => {
                event.currentTarget.value =
                  event.currentTarget.value.toUpperCase();
              }}
            />
          </Field>
          <Field label="Visibility" htmlFor="catalog-visibility">
            <Select id="catalog-visibility" name="visibility">
              <option value="organization">Organization</option>
              <option value="private">Private</option>
            </Select>
          </Field>
        </>
      ) : (
        <Field label="Team" htmlFor="catalog-team">
          <Select id="catalog-team" name="teamId" required>
            {workspace.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {kind === "projects" && (
        <>
          <Field label="Description" htmlFor="catalog-description">
            <Textarea
              id="catalog-description"
              name="description"
              maxLength={20000}
            />
          </Field>
          <ProjectPlanningFields
            idPrefix="catalog-project"
            members={workspace.members}
            value={planning}
            onChange={setPlanning}
          />
        </>
      )}
      {kind === "cycles" && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start date" htmlFor="cycle-start">
              <Input type="date" id="cycle-start" name="startsOn" required />
            </Field>
            <Field label="End date (exclusive)" htmlFor="cycle-end">
              <Input type="date" id="cycle-end" name="endsOn" required />
            </Field>
          </div>
          <Field label="Time zone" htmlFor="cycle-timezone">
            <Input
              id="cycle-timezone"
              name="timezone"
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
              required
              maxLength={100}
            />
          </Field>
          <Field label="Capacity (points)" htmlFor="cycle-capacity">
            <Input
              id="cycle-capacity"
              name="capacity"
              type="number"
              min={0}
              max={1000000}
              step="any"
            />
          </Field>
        </>
      )}
    </FormDialog>
  );
}
