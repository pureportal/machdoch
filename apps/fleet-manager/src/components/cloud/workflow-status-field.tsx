"use client";

import { useEffect, useRef, useState } from "react";
import {
  issueStates,
  issueStatusReferenceSchema,
  type CloudIssue,
} from "@/lib/cloud-contract";
import type { CloudTeamWorkflow } from "@/lib/cloud-workflow-contract";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { CloudRequestError, cloudRequest, formText } from "./api-client";

export function formIssueStatus(form: FormData) {
  const value = formText(form, "status");
  return value ? issueStatusReferenceSchema.parse(JSON.parse(value)) : null;
}

export function isWorkflowConflict(error: unknown): boolean {
  return (
    error instanceof CloudRequestError &&
    ["workflow_changed", "status_archived", "status_unavailable"].includes(
      error.code,
    )
  );
}

export function WorkflowStatusField({
  initial,
  current,
  reloadRequest = 0,
  id,
}: {
  initial: CloudTeamWorkflow;
  current?: Pick<CloudIssue, "status" | "statusName">;
  reloadRequest?: number;
  id: string;
}) {
  const [workflow, setWorkflow] = useState(initial);
  const initialStatus =
    current?.status ??
    initial.statuses.find((status) => status.id === initial.defaultStatusId)!;
  const [value, setValue] = useState(
    JSON.stringify({ id: initialStatus.id, revision: initialStatus.revision }),
  );
  const [reloaded, setReloaded] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const choices = workflow.statuses.filter(
    (status) => !status.archived || status.id === current?.status.id,
  );
  return (
    <Field label="Status" htmlFor={id}>
      <Select
        id={id}
        name="status"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        required
        disabled={loading}
      >
        <option value="" disabled>
          Choose status
        </option>
        {value &&
          !choices.some(
            (status) =>
              JSON.stringify({ id: status.id, revision: status.revision }) ===
              value,
          ) && (
            <option value={value}>
              {current?.statusName ?? "Status changed"}
            </option>
          )}
        {issueStates.map((category) => {
          const group = choices.filter(
            (status) => status.category === category,
          );
          return group.length ? (
            <optgroup
              key={category}
              label={category[0]!.toUpperCase() + category.slice(1)}
            >
              {group.map((status) => (
                <option
                  key={status.id}
                  value={JSON.stringify({
                    id: status.id,
                    revision: status.revision,
                  })}
                >
                  {status.name}
                  {status.archived ? " (archived)" : ""}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </Select>
      {reloadRequest !== reloaded && (
        <Button
          type="button"
          variant="outline"
          aria-busy={loading}
          aria-disabled={loading}
          onClick={() => {
            if (loadingRef.current) return;
            loadingRef.current = true;
            const controller = new AbortController();
            request.current = controller;
            setLoading(true);
            setError("");
            void cloudRequest<CloudTeamWorkflow>(
              `teams/${initial.teamId}/workflow`,
              { signal: controller.signal },
            )
              .then((latest) => {
                if (controller.signal.aborted) return;
                setWorkflow(latest);
                setValue("");
                setReloaded(reloadRequest);
              })
              .catch((reason: Error) => {
                if (!controller.signal.aborted) setError(reason.message);
              })
              .finally(() => {
                if (controller.signal.aborted) return;
                request.current = null;
                loadingRef.current = false;
                setLoading(false);
              });
          }}
        >
          {loading ? "Loading…" : "Reload statuses"}
        </Button>
      )}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
    </Field>
  );
}
