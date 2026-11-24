"use client";

import {
  projectStatuses,
  projectUpdateCadences,
  type CloudProject,
  type CloudWorkspace,
  type ProjectUpdateCadence,
} from "@/lib/cloud-contract";
import {
  projectStatusLabels,
  projectUpdateCadenceLabels,
} from "@/lib/project-status";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export type ProjectPlanning = Pick<
  CloudProject,
  "status" | "statusId" | "leadId" | "startsOn" | "targetOn"
> & { updateCadence?: ProjectUpdateCadence };

export function initialProjectPlanning(
  statuses: CloudWorkspace["projectStatuses"],
): ProjectPlanning {
  const status =
    statuses.find((candidate) => candidate.category === "planned") ??
    statuses[0]!;
  return {
    status: status.category,
    statusId: status.id,
    leadId: null,
    startsOn: null,
    targetOn: null,
  };
}

export function ProjectPlanningFields({
  idPrefix,
  members,
  statuses,
  value,
  onChange,
}: {
  idPrefix: string;
  members: CloudWorkspace["members"];
  statuses: CloudWorkspace["projectStatuses"];
  value: ProjectPlanning;
  onChange: (value: ProjectPlanning) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Status" htmlFor={`${idPrefix}-status`}>
          <Select
            id={`${idPrefix}-status`}
            value={value.statusId}
            onChange={(event) => {
              const status = statuses.find(
                (candidate) => candidate.id === event.target.value,
              )!;
              onChange({
                ...value,
                statusId: status.id,
                status: status.category,
              });
            }}
          >
            {projectStatuses.map((category) => (
              <optgroup key={category} label={projectStatusLabels[category]}>
                {statuses
                  .filter((status) => status.category === category)
                  .map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.name}
                    </option>
                  ))}
              </optgroup>
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
      {value.updateCadence && (
        <Field label="Update cadence" htmlFor={`${idPrefix}-cadence`}>
          <Select
            id={`${idPrefix}-cadence`}
            value={value.updateCadence}
            onChange={(event) =>
              onChange({
                ...value,
                updateCadence: event.target.value as ProjectUpdateCadence,
              })
            }
          >
            {projectUpdateCadences.map((cadence) => (
              <option key={cadence} value={cadence}>
                {projectUpdateCadenceLabels[cadence]}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </>
  );
}
