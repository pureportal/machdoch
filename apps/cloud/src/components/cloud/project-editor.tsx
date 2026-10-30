"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CloudProject, CloudWorkspace } from "@/lib/cloud-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";
import {
  ProjectPlanningFields,
  projectStatusLabels,
  type ProjectPlanning,
} from "./project-fields";

type ProjectDraft = Pick<CloudProject, "name" | "description"> &
  ProjectPlanning;
const draftFields = [
  "name",
  "description",
  "status",
  "leadId",
  "startsOn",
  "targetOn",
] as const satisfies readonly (keyof ProjectDraft)[];

function draftOf(project: CloudProject): ProjectDraft {
  return {
    name: project.name,
    description: project.description,
    status: project.status,
    leadId: project.leadId,
    startsOn: project.startsOn,
    targetOn: project.targetOn,
  };
}

export function ProjectEditor({
  id,
  members,
}: {
  id: string;
  members: CloudWorkspace["members"];
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  const request = useRef<AbortController | null>(null);
  const [project, setProject] = useState<CloudProject | null>(null);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [conflict, setConflict] = useState<CloudProject | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => request.current?.abort(), []);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-disabled={pending}
        aria-busy={pending}
        onClick={() => {
          if (request.current) return;
          const controller = new AbortController();
          request.current = controller;
          setPending(true);
          setError("");
          setConflict(null);
          sender.current = createCommandSender();
          void cloudRequest<CloudProject>(`projects/${id}`, {
            signal: controller.signal,
          })
            .then((value) => {
              if (!controller.signal.aborted) {
                setProject(value);
                setDraft(draftOf(value));
              }
            })
            .catch((reason: Error) => {
              if (!controller.signal.aborted) setError(reason.message);
            })
            .finally(() => {
              if (!controller.signal.aborted) {
                request.current = null;
                setPending(false);
              }
            });
        }}
      >
        {pending ? "Opening…" : "Edit project"}
      </Button>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <FormDialog
        open={project !== null}
        onOpenChange={(open) => {
          if (!open) setProject(null);
        }}
        title="Edit project"
        submitLabel="Save project"
        onSubmit={async () => {
          if (!project || !draft) return;
          if (conflict)
            throw new Error("Choose which changes to keep before saving.");
          try {
            await sender.current(
              `projects/${id}`,
              { revision: project.revision, ...draft },
              "PATCH",
            );
          } catch (reason) {
            if (
              reason instanceof CloudRequestError &&
              reason.code === "revision_conflict"
            ) {
              const latest = await cloudRequest<CloudProject>(`projects/${id}`);
              setConflict(latest);
              throw new Error(
                "This project changed. Review the latest version before saving.",
              );
            }
            throw reason;
          }
          router.refresh();
        }}
      >
        {draft && (
          <>
            <Field label="Name" htmlFor={`project-name-${id}`}>
              <Input
                id={`project-name-${id}`}
                name="name"
                required
                maxLength={120}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </Field>
            <Field label="Description" htmlFor={`project-description-${id}`}>
              <Textarea
                id={`project-description-${id}`}
                name="description"
                maxLength={20000}
                value={draft.description}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </Field>
            <ProjectPlanningFields
              idPrefix={`project-${id}`}
              members={members}
              value={draft}
              onChange={(planning) => setDraft({ ...draft, ...planning })}
            />
          </>
        )}
        {conflict && project && draft && (
          <section
            aria-label="Latest saved version"
            className="grid min-w-0 gap-3 rounded-lg border p-4"
          >
            <h3>Latest saved version</h3>
            <p className="break-words font-medium">{conflict.name}</p>
            <p className="text-sm text-muted-foreground">
              {projectStatusLabels[conflict.status]}
              {conflict.targetOn ? ` · Target ${conflict.targetOn}` : ""}
            </p>
            {conflict.description && (
              <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
                {conflict.description}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDraft(draftOf(conflict));
                  setProject(conflict);
                  setConflict(null);
                }}
              >
                Use latest
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const latest = draftOf(conflict);
                  const original = draftOf(project);
                  setDraft(
                    Object.fromEntries(
                      draftFields.map((field) => [
                        field,
                        draft[field] === original[field]
                          ? latest[field]
                          : draft[field],
                      ]),
                    ) as ProjectDraft,
                  );
                  setProject(conflict);
                  setConflict(null);
                }}
              >
                Keep my changes
              </Button>
            </div>
          </section>
        )}
      </FormDialog>
    </>
  );
}
