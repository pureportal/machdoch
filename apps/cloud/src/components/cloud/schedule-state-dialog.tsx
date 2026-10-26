"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { CloudSchedule } from "@/lib/cloud-schedule-contract";
import type { CloudWorkspace } from "@/lib/cloud-contract";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  cloudRequest,
  CloudRequestError,
  createCommandSender,
} from "./api-client";

export interface ScheduleTransition {
  schedule: CloudSchedule;
  field: "enabled" | "archived";
  target: boolean;
}
export function ScheduleStateDialog({
  transition,
  workspace,
  onClose,
  onSaved,
  returnFocus,
}: {
  transition: ScheduleTransition;
  workspace: CloudWorkspace;
  onClose: () => void;
  onSaved: () => Promise<void>;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [current, setCurrent] = useState(transition.schedule),
    [conflict, setConflict] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null),
    sender = useRef(createCommandSender());
  useEffect(() => () => controller.current?.abort(), []);
  const { field, target } = transition;
  const label =
    field === "archived"
      ? target
        ? "Archive schedule"
        : "Restore schedule"
      : target
        ? "Enable schedule"
        : "Pause schedule";
  let consequence =
    field === "archived"
      ? target
        ? "This hides the schedule and stops future occurrences. Work already started continues."
        : "The schedule returns as a paused draft."
      : !target
        ? "Future occurrences stop. Work already started continues."
        : "This creates issues in the selected team, starting with the next scheduled date.";
  if (field === "enabled" && target && current.action.kind === "run-task")
    consequence = `This authorizes up to ${current.action.maxRuns - current.admittedRuns} more AI tasks with ${(current.action.maxTokens - current.usedTokens - current.reservedTokens).toLocaleString()} tokens currently available until ${new Date(current.action.expiresAt).toISOString().replace("T", " ").replace(".000Z", " UTC")}. ${current.recurrence.kind === "fixed-delay" ? "The next task waits for the preceding task to finish." : "Dates that overlap an active task are skipped."}`;
  return (
    <FormDialog
      open
      title={label}
      submitLabel={label}
      submitDisabled={conflict || loading}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      focusWhenOpenerRemoved={returnFocus}
      onSubmit={async () => {
        try {
          await sender.current(
            `schedules/${current.id}/${field === "archived" ? "archive" : "state"}`,
            {
              account: {
                organizationId: workspace.organization.id,
                userId: workspace.actor.id,
              },
              revision: current.revision,
              [field]: target,
            },
          );
          await onSaved();
        } catch (reason) {
          if (
            reason instanceof CloudRequestError &&
            reason.code === "revision_conflict"
          )
            setConflict(true);
          throw reason;
        }
      }}
    >
      <p>{consequence}</p>
      {conflict && (
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => {
            controller.current?.abort();
            const abort = new AbortController();
            controller.current = abort;
            setLoading(true);
            setError("");
            void cloudRequest<CloudSchedule>(`schedules/${current.id}`, {
              signal: abort.signal,
            })
              .then((record) => {
                if (!abort.signal.aborted) {
                  setCurrent(record);
                  setConflict(false);
                }
              })
              .catch((reason: Error) => {
                if (!abort.signal.aborted) setError(reason.message);
              })
              .finally(() => {
                if (!abort.signal.aborted) setLoading(false);
              });
          }}
        >
          Load current version
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </FormDialog>
  );
}
