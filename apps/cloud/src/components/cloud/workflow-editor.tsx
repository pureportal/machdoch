"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  workflowDefinitionSchema,
  type CloudTeamWorkflow,
  type WorkflowDefinition,
  type WorkflowImpact,
} from "@/lib/cloud-workflow-contract";
import { WorkflowStatusList } from "./workflow-status-list";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";

function editable(workflow: CloudTeamWorkflow): WorkflowDefinition {
  return {
    revision: workflow.revision,
    defaultStatusId: workflow.defaultStatusId,
    statuses: workflow.statuses.map(({ revision: _, ...status }) => status),
  };
}

export function WorkflowEditor({ teamId }: { teamId: string }) {
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [impact, setImpact] = useState<WorkflowImpact | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [conflict, setConflict] = useState<CloudTeamWorkflow | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const request = useRef<AbortController | null>(null);
  const sender = useRef(createCommandSender());
  const existingIds = useRef(new Set<string>());
  const router = useRouter();
  useEffect(() => () => request.current?.abort(), []);
  function change(next: WorkflowDefinition) {
    setDraft(next);
    setImpact(null);
    setConfirmed(false);
  }
  return (
    <>
      <Button
        variant="outline"
        aria-busy={opening}
        aria-disabled={opening}
        onClick={() => {
          if (request.current) return;
          const abort = new AbortController();
          request.current = abort;
          setOpening(true);
          setError("");
          void cloudRequest<CloudTeamWorkflow>(`teams/${teamId}/workflow`, {
            signal: abort.signal,
          })
            .then((workflow) => {
              if (abort.signal.aborted) return;
              existingIds.current = new Set(
                workflow.statuses.map((status) => status.id),
              );
              change(editable(workflow));
              setConflict(null);
              sender.current = createCommandSender();
            })
            .catch((reason: Error) => {
              if (!abort.signal.aborted) setError(reason.message);
            })
            .finally(() => {
              if (!abort.signal.aborted) {
                request.current = null;
                setOpening(false);
              }
            });
        }}
      >
        {opening ? "Opening…" : "Workflow"}
      </Button>
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <FormDialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        title="Team workflow"
        submitLabel="Save workflow"
        submitDisabled={!!conflict || (!!impact && !confirmed)}
        onSubmit={async () => {
          if (!draft) return;
          const parsed = workflowDefinitionSchema.safeParse(draft);
          if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
          const definition = parsed.data;
          try {
            const reviewed =
              impact ??
              (await cloudRequest<WorkflowImpact>(
                `teams/${teamId}/workflow/preview`,
                { method: "POST", body: definition, key: crypto.randomUUID() },
              ));
            if (!impact) {
              setImpact(reviewed);
              const needsReview = !!(
                reviewed.changedIssues || reviewed.pausedSchedules
              );
              setConfirmed(!needsReview);
              if (needsReview)
                throw new Error("Review these changes before saving.");
            }
            await sender.current(
              `teams/${teamId}/workflow`,
              { definition, impactDigest: reviewed.digest },
              "PATCH",
            );
            router.refresh();
          } catch (reason) {
            if (
              reason instanceof CloudRequestError &&
              reason.code === "revision_conflict"
            ) {
              setConflict(
                await cloudRequest<CloudTeamWorkflow>(
                  `teams/${teamId}/workflow`,
                ),
              );
              throw new Error(
                "The workflow changed. Reload it before editing.",
              );
            }
            if (
              reason instanceof CloudRequestError &&
              reason.code === "workflow_impact_changed"
            ) {
              const latestImpact = await cloudRequest<WorkflowImpact>(
                `teams/${teamId}/workflow/preview`,
                { method: "POST", body: definition, key: crypto.randomUUID() },
              );
              setImpact(latestImpact);
              setConfirmed(
                !latestImpact.changedIssues && !latestImpact.pausedSchedules,
              );
            }
            throw reason;
          }
        }}
      >
        {draft && (
          <>
            {conflict && (
              <section
                aria-label="Latest workflow"
                className="rounded-md border p-3"
              >
                <ul>
                  {conflict.statuses
                    .filter((status) => !status.archived)
                    .map((status) => (
                      <li key={status.id}>
                        {status.name} · {status.category}
                      </li>
                    ))}
                </ul>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    existingIds.current = new Set(
                      conflict.statuses.map((status) => status.id),
                    );
                    change(editable(conflict));
                    setConflict(null);
                  }}
                >
                  Reload workflow
                </Button>
              </section>
            )}
            <WorkflowStatusList
              key={draft.revision}
              draft={draft}
              teamId={teamId}
              existingIds={existingIds.current}
              onChange={change}
            />
            {impact &&
              (impact.changedIssues > 0 || impact.pausedSchedules > 0) && (
                <section
                  aria-label="Workflow impact"
                  className="grid gap-2 rounded-md border p-3"
                >
                  {impact.changedIssues > 0 && (
                    <p>
                      {impact.changedIssues}{" "}
                      {impact.changedIssues === 1
                        ? "issue changes"
                        : "issues change"}{" "}
                      category.
                    </p>
                  )}
                  {impact.pausedSchedules > 0 && (
                    <p>
                      {impact.pausedSchedules}{" "}
                      {impact.pausedSchedules === 1
                        ? "schedule pauses"
                        : "schedules pause"}
                      .
                    </p>
                  )}
                  {impact.changedTasks > 0 && (
                    <p>
                      {impact.changedTasks} active{" "}
                      {impact.changedTasks === 1 ? "task keeps" : "tasks keep"}{" "}
                      their original instructions.
                    </p>
                  )}
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    Apply these changes
                  </label>
                </section>
              )}
          </>
        )}
      </FormDialog>
    </>
  );
}
