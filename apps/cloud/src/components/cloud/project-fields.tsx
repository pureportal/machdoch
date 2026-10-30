"use client";

import {
  projectStatuses,
  type CloudProject,
  type CloudWorkspace,
} from "@/lib/cloud-contract";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export type ProjectPlanning = Pick<
  CloudProject,
  "status" | "leadId" | "startsOn" | "targetOn"
>;

export const initialProjectPlanning: ProjectPlanning = {
  status: "planned",
  leadId: null,
  startsOn: null,
  targetOn: null,
};

export const projectStatusLabels: Record<CloudProject["status"], string> = {
  backlog: "Backlog",
  planned: "Planned",
  active: "In progress",
  paused: "Paused",
  completed: "Completed",
  canceled: "Canceled",
};

export const projectStatusStates: Record<
  CloudProject["status"],
  "backlog" | "ready" | "active" | "blocked" | "complete" | "canceled"
> = {
  backlog: "backlog",
  planned: "ready",
  active: "active",
  paused: "blocked",
  completed: "complete",
  canceled: "canceled",
};

export function ProjectPlanningFields({
  idPrefix,
  members,
  value,
  onChange,
}: {
  idPrefix: string;
  members: CloudWorkspace["members"];
  value: ProjectPlanning;
  onChange: (value: ProjectPlanning) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Status" htmlFor={`${idPrefix}-status`}>
          <Select
            id={`${idPrefix}-status`}
            value={value.status}
            onChange={(event) =>
              onChange({
                ...value,
                status: event.target.value as CloudProject["status"],
              })
            }
          >
            {projectStatuses.map((status) => (
              <option key={status} value={status}>
                {projectStatusLabels[status]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Lead" htmlFor={`${idPrefix}-lead`}>
          <Select
            id={`${idPrefix}-lead`}
            value={value.leadId ?? ""}
            onChange={(event) =>
              onChange({ ...value, leadId: event.target.value || null })
            }
          >
            <option value="">No lead</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Start date" htmlFor={`${idPrefix}-start`}>
          <Input
            id={`${idPrefix}-start`}
            type="date"
            value={value.startsOn ?? ""}
            onChange={(event) =>
              onChange({ ...value, startsOn: event.target.value || null })
            }
          />
        </Field>
        <Field label="Target date" htmlFor={`${idPrefix}-target`}>
          <Input
            id={`${idPrefix}-target`}
            type="date"
            min={value.startsOn ?? undefined}
            value={value.targetOn ?? ""}
            onChange={(event) =>
              onChange({ ...value, targetOn: event.target.value || null })
            }
          />
        </Field>
      </div>
    </>
  );
}
