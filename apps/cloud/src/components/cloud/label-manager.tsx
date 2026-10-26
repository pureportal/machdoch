"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { labelColors, type CloudLabel } from "@/lib/cloud-label-contract";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
  formText,
} from "./api-client";
import { LabelChip } from "./label-chip";

export function LabelManager({
  teamId,
  writable,
}: {
  teamId: string;
  writable: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [labels, setLabels] = useState<CloudLabel[]>([]);
  const [editing, setEditing] = useState<{ label: CloudLabel | null } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const sender = useRef(createCommandSender());
  const sequence = useRef(0);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const current = ++sequence.current;
      const result = await cloudRequest<{ labels: CloudLabel[] }>(
        `teams/${teamId}/labels`,
        { signal },
      );
      if (current === sequence.current && !signal?.aborted) {
        setLabels(result.labels);
        setError("");
      }
    },
    [teamId],
  );
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setLoading(true);
    void refresh(controller.signal)
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      sequence.current++;
    };
  }, [expanded, refresh]);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer py-2">Labels</summary>
      {loading && <p role="status">Loading labels…</p>}
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      <div className="my-3 flex flex-wrap gap-2">
        {labels.map((label) =>
          writable ? (
            <Button
              key={label.id}
              variant="ghost"
              aria-label={`Edit label ${label.name}`}
              onClick={() => {
                sender.current = createCommandSender();
                setEditing({ label });
              }}
            >
              <LabelChip label={label} />
            </Button>
          ) : (
            <LabelChip key={label.id} label={label} />
          ),
        )}
      </div>
      {writable && (
        <Button
          variant="outline"
          onClick={() => {
            sender.current = createCommandSender();
            setEditing({ label: null });
          }}
        >
          New label
        </Button>
      )}
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing?.label ? "Edit label" : "New label"}
        submitLabel={editing?.label ? "Save label" : "Create label"}
        onSubmit={async (form) => {
          if (!editing) return;
          const body = {
            name: formText(form, "name"),
            color: formText(form, "color"),
          };
          try {
            if (editing.label)
              await sender.current(
                `labels/${editing.label.id}`,
                {
                  ...body,
                  revision: editing.label.revision,
                  archived: form.get("archived") === "on",
                },
                "PATCH",
              );
            else await sender.current(`teams/${teamId}/labels`, body);
          } catch (reason) {
            if (
              reason instanceof CloudRequestError &&
              reason.code === "revision_conflict"
            ) {
              await refresh();
              throw new Error(
                "This label changed. Close and reopen it to load the latest version.",
              );
            }
            throw reason;
          }
          await refresh();
        }}
      >
        <Field label="Name" htmlFor={`label-name-${teamId}`}>
          <Input
            name="name"
            id={`label-name-${teamId}`}
            defaultValue={editing?.label?.name ?? ""}
            required
            maxLength={80}
          />
        </Field>
        <Field label="Color" htmlFor={`label-color-${teamId}`}>
          <Select
            name="color"
            id={`label-color-${teamId}`}
            defaultValue={editing?.label?.color ?? "blue"}
          >
            {labelColors.map((color) => (
              <option key={color} value={color}>
                {color[0]!.toUpperCase() + color.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        {editing?.label && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="archived"
              defaultChecked={editing.label.archived}
            />
            Archived
          </label>
        )}
      </FormDialog>
    </details>
  );
}
