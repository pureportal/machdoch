"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import {
  defaultEstimateScale,
  type CloudWorkspace,
} from "@/lib/cloud-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { createCommandSender, formText } from "./api-client";
import { EstimateScaleEditor } from "./scale-editor";
import { TeamEditor } from "./team-editor";
import { ProjectEditor } from "./project-editor";
import { LabelManager } from "./label-manager";
import { WorkflowEditor } from "./workflow-editor";

export function PlanningCatalog({
  kind,
  workspace,
}: {
  kind: "teams" | "projects" | "cycles";
  workspace: CloudWorkspace;
}) {
  const [open, setOpen] = useState(false);
  const sender = useRef(createCommandSender());
  const router = useRouter();
  const labels = {
    teams: { title: "Teams", single: "team" },
    projects: { title: "Projects", single: "project" },
    cycles: { title: "Cycles", single: "cycle" },
  }[kind];
  const writable =
    workspace.actor.role !== "viewer" &&
    (kind !== "teams" || ["owner", "admin"].includes(workspace.actor.role));
  const items = workspace[kind];
  return (
    <>
      <header className="cloud-page-header">
        <h1>{labels.title}</h1>
        {writable && (kind === "teams" || workspace.teams.length > 0) && (
          <Button onClick={() => setOpen(true)}>
            <Plus />
            New {labels.single}
          </Button>
        )}
      </header>
      {!items.length ? (
        <div className="cloud-empty">
          <p>No {kind} yet.</p>
          {kind !== "teams" && !workspace.teams.length && (
            <Link className="underline" href="/cloud/teams">
              Create a team
            </Link>
          )}
        </div>
      ) : (
        <div className="cloud-grid">
          {items.map((item) => (
            <section
              className="cloud-card"
              key={item.id}
              id={`planning-${item.id}`}
            >
              <h2>
                <Link
                  href={
                    kind === "cycles"
                      ? `/cloud/cycles/${item.id}`
                      : `/cloud/issues?${kind === "teams" ? "teamId" : "projectId"}=${item.id}`
                  }
                >
                  {item.name}
                </Link>
              </h2>
              {"key" in item && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{item.key}</span>
                  <span>
                    {item.visibility === "private" ? "Private" : "Organization"}
                  </span>
                </div>
              )}
              {"description" in item && item.description && (
                <p>{item.description}</p>
              )}
              {"startsOn" in item && (
                <>
                  <p>
                    {item.startsOn} → {item.endsOn}
                  </p>
                  <span className="capitalize">{item.status}</span>
                  {item.capacity !== null && (
                    <p>Capacity: {item.capacity} points</p>
                  )}
                </>
              )}
              {"teamId" in item && (
                <span className="text-muted-foreground">
                  {
                    workspace.teams.find((team) => team.id === item.teamId)
                      ?.name
                  }
                </span>
              )}
              {"estimateScale" in item && writable && (
                <EstimateScaleEditor team={item} />
              )}
              {"estimateScale" in item && writable && (
                <TeamEditor team={item} workspace={workspace} />
              )}
              {"estimateScale" in item && (
                <LabelManager
                  teamId={item.id}
                  writable={workspace.actor.role !== "viewer"}
                />
              )}
              {"estimateScale" in item &&
                ["owner", "admin"].includes(workspace.actor.role) && (
                  <WorkflowEditor teamId={item.id} />
                )}
              {"description" in item && writable && (
                <ProjectEditor id={item.id} />
              )}
            </section>
          ))}
        </div>
      )}
      <FormDialog
        title={`New ${labels.single}`}
        submitLabel={`Create ${labels.single}`}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) sender.current = createCommandSender();
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
          <Field label="Description" htmlFor="catalog-description">
            <Textarea
              id="catalog-description"
              name="description"
              maxLength={20000}
            />
          </Field>
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
    </>
  );
}
