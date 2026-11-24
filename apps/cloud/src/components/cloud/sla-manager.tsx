"use client";

import { LoadingState } from "@machdoch/product-ui";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudLabel } from "@/lib/cloud-label-contract";
import {
  slaDuration,
  slaPriorities,
  type CloudSlaPolicy,
} from "@/lib/issue-sla";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  cloudRequest,
  createCommandSender,
  formReference,
  formText,
} from "./api-client";
import { priorityNames } from "./issue-properties";

function policyScope(policy: CloudSlaPolicy) {
  return [policy.priority && priorityNames[policy.priority], policy.labelName]
    .filter(Boolean)
    .join(" · ");
}

export function SlaManager({
  teamId,
  teamName,
  writable,
}: {
  teamId: string;
  teamName: string;
  writable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [policies, setPolicies] = useState<CloudSlaPolicy[]>([]);
  const [labels, setLabels] = useState<CloudLabel[]>([]);
  const [editing, setEditing] = useState<{
    policy: CloudSlaPolicy | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const sender = useRef(createCommandSender());
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const [slaResult, labelResult] = await Promise.all([
        cloudRequest<{ policies: CloudSlaPolicy[] }>("slas", { signal }),
        cloudRequest<{ labels: CloudLabel[] }>(`teams/${teamId}/labels`, {
          signal,
        }),
      ]);
      if (signal?.aborted) return;
      setPolicies(
        slaResult.policies.filter((policy) => policy.teamId === teamId),
      );
      setLabels(labelResult.labels.filter((label) => !label.archived));
      setError("");
    },
    [teamId],
  );
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    void refresh(controller.signal)
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, refresh]);
  async function remove(policy: CloudSlaPolicy) {
    try {
      await cloudRequest(`slas/${policy.id}`, { method: "DELETE" });
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        SLAs
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>{teamName} SLAs</DialogTitle>
          {loading && <LoadingState label="Loading SLAs…" compact />}
          {error && (
            <p role="alert" className="cloud-error">
              {error}
            </p>
          )}
          {!loading && (
            <ul className="cloud-setting-list">
              {policies.length === 0 && (
                <li className="text-sm text-muted-foreground">No SLAs yet.</li>
              )}
              {policies.map((policy) => (
                <li key={policy.id}>
                  {writable ? (
                    <button
                      type="button"
                      aria-label={`Edit SLA ${policyScope(policy)}`}
                      onClick={() => {
                        sender.current = createCommandSender();
                        setEditing({ policy });
                      }}
                    >
                      <span>{policyScope(policy)}</span>
                      <strong>{slaDuration(policy.hours)}</strong>
                    </button>
                  ) : (
                    <span>
                      <span>{policyScope(policy)}</span>
                      <strong>{slaDuration(policy.hours)}</strong>
                    </span>
                  )}
                  {writable && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete SLA ${policyScope(policy)}`}
                      onClick={() => void remove(policy)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {writable && (
            <Button
              variant="outline"
              className="justify-self-start"
              onClick={() => {
                sender.current = createCommandSender();
                setEditing({ policy: null });
              }}
            >
              <Plus />
              New SLA
            </Button>
          )}
        </DialogContent>
      </Dialog>
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing?.policy ? policyScope(editing.policy) : "New SLA"}
        submitLabel={editing?.policy ? "Save SLA" : "Create SLA"}
        onSubmit={async (form) => {
          if (!editing) return;
          const hours = Number(formText(form, "hours"));
          if (editing.policy)
            await sender.current(
              `slas/${editing.policy.id}`,
              { hours },
              "PATCH",
            );
          else
            await sender.current("slas", {
              teamId,
              priority: formReference(form, "priority"),
              labelId: formReference(form, "labelId"),
              hours,
            });
          await refresh();
        }}
      >
        {!editing?.policy && (
          <>
            <Field label="Priority" htmlFor={`sla-priority-${teamId}`}>
              <Select name="priority" id={`sla-priority-${teamId}`}>
                <option value="">Any</option>
                {slaPriorities.map((priority) => (
                  <option key={priority} value={priority}>
                    {priorityNames[priority]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Label" htmlFor={`sla-label-${teamId}`}>
              <Select name="labelId" id={`sla-label-${teamId}`}>
                <option value="">Any</option>
                {labels.map((label) => (
                  <option key={label.id} value={label.id}>
                    {label.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        <Field label="Hours" htmlFor={`sla-hours-${teamId}`}>
          <Input
            name="hours"
            id={`sla-hours-${teamId}`}
            type="number"
            min={1}
            max={8760}
            required
            defaultValue={editing?.policy?.hours ?? 24}
          />
        </Field>
      </FormDialog>
    </>
  );
}
