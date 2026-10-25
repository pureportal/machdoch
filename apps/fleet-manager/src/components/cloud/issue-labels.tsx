"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudIssue } from "@/lib/cloud-contract";
import type { CloudLabel, CloudIssueLabels } from "@/lib/cloud-label-contract";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CloudRequestError,
  cloudRequest,
  createCommandSender,
} from "./api-client";
import { LabelChip } from "./label-chip";

interface Selection {
  original: CloudIssueLabels;
  choices: CloudLabel[];
  selected: string[];
}

export function IssueLabels({
  issue,
  writable,
}: {
  issue: CloudIssue;
  writable: boolean;
}) {
  const [current, setCurrent] = useState<CloudIssueLabels>({
    revision: 1,
    labels: [],
  });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [conflict, setConflict] = useState<CloudIssueLabels | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const sequence = useRef(0);
  const openingRequest = useRef<AbortController | null>(null);
  const sender = useRef(createCommandSender());
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const serial = ++sequence.current;
      const result = await cloudRequest<CloudIssueLabels>(
        `issues/${issue.id}/labels`,
        { signal },
      );
      if (serial === sequence.current && !signal?.aborted) {
        setCurrent(result);
        setError("");
      }
      return result;
    },
    [issue.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (!document.hidden) await refresh(controller.signal);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (
          reason instanceof CloudRequestError &&
          [401, 403, 404].includes(reason.status)
        ) {
          setCurrent({ revision: 1, labels: [] });
          setSelection(null);
          openingRequest.current?.abort();
          openingRequest.current = null;
          setOpening(false);
        }
        setError((reason as Error).message);
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      controller.abort();
      openingRequest.current?.abort();
      clearTimeout(timer);
      sequence.current++;
    };
  }, [refresh]);
  return (
    <section
      aria-label="Issue labels"
      className="mt-6 flex flex-wrap items-center gap-2"
    >
      {current.labels.map((label) => (
        <Link
          key={label.id}
          href={`/cloud/issues?teamId=${issue.teamId}&labelId=${label.id}`}
        >
          <LabelChip label={label} />
        </Link>
      ))}
      {writable && !issue.archived && (
        <Button
          variant="outline"
          aria-disabled={opening}
          aria-busy={opening}
          onClick={() => {
            if (openingRequest.current) return;
            const controller = new AbortController();
            openingRequest.current = controller;
            setOpening(true);
            setError("");
            setConflict(null);
            setQuery("");
            sender.current = createCommandSender();
            void Promise.all([
              refresh(controller.signal),
              cloudRequest<{ labels: CloudLabel[] }>(
                `teams/${issue.teamId}/labels`,
                { signal: controller.signal },
              ),
            ])
              .then(([original, choices]) => {
                if (!controller.signal.aborted)
                  setSelection({
                    original,
                    choices: choices.labels,
                    selected: original.labels.map((label) => label.id),
                  });
              })
              .catch((reason: Error) => {
                if (!controller.signal.aborted) setError(reason.message);
              })
              .finally(() => {
                if (!controller.signal.aborted) {
                  openingRequest.current = null;
                  setOpening(false);
                }
              });
          }}
        >
          {opening ? "Opening…" : "Labels"}
        </Button>
      )}
      {error && (
        <p role="alert" className="cloud-error w-full">
          {error}
        </p>
      )}
      <FormDialog
        title="Labels"
        submitLabel="Save labels"
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
        onSubmit={async () => {
          if (!selection) return;
          if (conflict)
            throw new Error("Choose which labels to keep before saving.");
          try {
            await sender.current(
              `issues/${issue.id}/labels`,
              {
                revision: selection.original.revision,
                labelIds: selection.selected,
              },
              "PATCH",
            );
          } catch (reason) {
            if (
              reason instanceof CloudRequestError &&
              reason.code === "revision_conflict"
            ) {
              const [latest, catalog] = await Promise.all([
                refresh(),
                cloudRequest<{ labels: CloudLabel[] }>(
                  `teams/${issue.teamId}/labels`,
                ),
              ]);
              setSelection({ ...selection, choices: catalog.labels });
              setConflict(latest);
              throw new Error(
                "The labels changed. Review the latest selection before saving.",
              );
            }
            throw reason;
          }
          await refresh();
        }}
      >
        <Input
          aria-label="Find labels"
          placeholder="Find labels…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={80}
        />
        <div className="grid max-h-72 gap-2 overflow-auto">
          {selection?.choices
            .filter(
              (label) =>
                (!label.archived ||
                  selection.original.labels.some(
                    (assigned) => assigned.id === label.id,
                  )) &&
                label.name.toLowerCase().includes(query.toLowerCase()),
            )
            .map((label) => (
              <label className="flex items-center gap-3" key={label.id}>
                <input
                  type="checkbox"
                  checked={selection.selected.includes(label.id)}
                  disabled={
                    !selection.selected.includes(label.id) &&
                    selection.selected.length >= 30
                  }
                  onChange={(event) =>
                    setSelection({
                      ...selection,
                      selected: event.target.checked
                        ? [...selection.selected, label.id]
                        : selection.selected.filter((id) => id !== label.id),
                    })
                  }
                />
                <LabelChip label={label} />
              </label>
            ))}
          {selection &&
            selection.choices.every((label) => label.archived) &&
            selection.original.labels.length === 0 && (
              <p>No labels available.</p>
            )}
        </div>
        {selection && selection.selected.length >= 30 && (
          <p role="status">Remove a label to select another.</p>
        )}
        {conflict && selection && (
          <section
            aria-label="Latest labels"
            className="grid gap-3 rounded-lg border p-4"
          >
            <h3>Latest labels</h3>
            <div className="flex flex-wrap gap-2">
              {conflict.labels.length ? (
                conflict.labels.map((label) => (
                  <LabelChip key={label.id} label={label} />
                ))
              ) : (
                <span>No labels</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSelection({
                    ...selection,
                    original: conflict,
                    selected: conflict.labels.map((label) => label.id),
                  });
                  setConflict(null);
                }}
              >
                Use latest
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const previous = new Set(
                    selection.original.labels.map((label) => label.id),
                  );
                  const removed = new Set(
                    [...previous].filter(
                      (id) => !selection.selected.includes(id),
                    ),
                  );
                  const added = selection.selected.filter(
                    (id) => !previous.has(id),
                  );
                  setSelection({
                    ...selection,
                    original: conflict,
                    selected: [
                      ...new Set([
                        ...conflict.labels
                          .map((label) => label.id)
                          .filter((id) => !removed.has(id)),
                        ...added,
                      ]),
                    ],
                  });
                  setConflict(null);
                }}
              >
                Keep my changes
              </Button>
            </div>
          </section>
        )}
      </FormDialog>
    </section>
  );
}
