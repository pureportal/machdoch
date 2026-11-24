"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  defaultEstimateScale,
  type CloudWorkspace,
} from "@/lib/cloud-contract";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { MarkdownTextarea } from "./markdown-textarea";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { createCommandSender, formText } from "./api-client";
import {
  ProjectPlanningFields,
  initialProjectPlanning,
} from "./project-fields";
import { TimezoneSelect } from "./timezone-select";

const cycleLengths = [7, 14, 21, 28];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function teamKey(name: string): string {
  const words = name
    .normalize("NFKD")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const key =
    words.length > 1
      ? words.map((word) => word[0]).join("")
      : (words[0] ?? "").slice(0, 3);
  return key.replace(/^[0-9]+/, "").slice(0, 10);
}

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
  const [planning, setPlanning] = useState(() =>
    initialProjectPlanning(workspace.projectStatuses),
  );
  const [teamName, setTeamName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [teamId, setTeamId] = useState(workspace.teams[0]?.id ?? "");
  const today = isoDate(new Date());
  const teamCycles = workspace.cycles.filter(
    (cycle) => cycle.teamId === teamId,
  );
  const latestEnd = teamCycles
    .map((cycle) => cycle.endsOn)
    .sort()
    .at(-1);
  const [startsOn, setStartsOn] = useState<string | null>(null);
  const [length, setLength] = useState(14);
  const start =
    startsOn ?? (latestEnd && latestEnd > today ? latestEnd : today);
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
          setPlanning(initialProjectPlanning(workspace.projectStatuses));
          setTeamName("");
          setKey(null);
          setStartsOn(null);
          setLength(14);
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
            startsOn: start,
            endsOn: addDays(start, length),
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
        <Input
          name="name"
          id="catalog-name"
          required
          maxLength={120}
          key={kind === "cycles" ? teamId : kind}
          defaultValue={
            kind === "cycles" ? `Cycle ${teamCycles.length + 1}` : undefined
          }
          onChange={(event) => {
            if (kind === "teams") setTeamName(event.target.value);
          }}
        />
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
              value={key ?? teamKey(teamName)}
              onChange={(event) =>
                setKey(
                  event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                )
              }
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
          <Select
            id="catalog-team"
            name="teamId"
            required
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
              setStartsOn(null);
            }}
          >
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
            <MarkdownTextarea
              id="catalog-description"
              name="description"
              maxLength={20000}
            />
          </Field>
          <ProjectPlanningFields
            idPrefix="catalog-project"
            members={workspace.members}
            statuses={workspace.projectStatuses}
            value={planning}
            onChange={setPlanning}
          />
        </>
      )}
      {kind === "cycles" && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Starts" htmlFor="cycle-start">
              <Input
                type="date"
                id="cycle-start"
                required
                value={start}
                onChange={(event) => setStartsOn(event.target.value)}
              />
            </Field>
            <Field label="Length" htmlFor="cycle-length">
              <Select
                id="cycle-length"
                value={String(length)}
                onChange={(event) => setLength(Number(event.target.value))}
              >
                {cycleLengths.map((days) => (
                  <option key={days} value={days}>
                    {days / 7} {days === 7 ? "week" : "weeks"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Time zone" htmlFor="cycle-timezone">
            <TimezoneSelect
              id="cycle-timezone"
              name="timezone"
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
              required
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
