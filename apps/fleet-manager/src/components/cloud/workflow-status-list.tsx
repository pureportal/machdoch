"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { issueStates } from "@/lib/cloud-contract";
import type { WorkflowDefinition } from "@/lib/cloud-workflow-contract";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export function WorkflowStatusList({
  draft,
  existingIds,
  onChange,
  teamId,
}: {
  draft: WorkflowDefinition;
  existingIds: ReadonlySet<string>;
  onChange: (next: WorkflowDefinition) => void;
  teamId: string;
}) {
  const [showArchived, setShowArchived] = useState(false);
  function updateStatus(
    id: string,
    change: Partial<WorkflowDefinition["statuses"][number]>,
  ) {
    const statuses = draft.statuses.map((status) =>
      status.id === id ? { ...status, ...change } : status,
    );
    const initial = statuses.find(
      (status) => status.id === draft.defaultStatusId,
    );
    onChange({
      ...draft,
      statuses,
      defaultStatusId:
        !initial ||
        initial.archived ||
        ["complete", "canceled"].includes(initial.category)
          ? ""
          : draft.defaultStatusId,
    });
  }
  return (
    <>
      <Field label="Default status" htmlFor={`workflow-default-${teamId}`}>
        <Select
          id={`workflow-default-${teamId}`}
          value={draft.defaultStatusId}
          required
          onChange={(event) =>
            onChange({ ...draft, defaultStatusId: event.target.value })
          }
        >
          <option value="" disabled>
            Choose status
          </option>
          {draft.statuses
            .filter(
              (status) =>
                !status.archived &&
                !["complete", "canceled"].includes(status.category),
            )
            .map((status) => (
              <option key={status.id} value={status.id}>
                {status.name}
              </option>
            ))}
        </Select>
      </Field>
      <div className="grid gap-3">
        {draft.statuses.map((status, index) =>
          !status.archived || showArchived ? (
            <fieldset
              key={status.id}
              className="grid min-w-0 gap-3 rounded-lg border p-3"
              aria-label={`Status ${index + 1}`}
            >
              <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
                <Field label="Name" htmlFor={`status-name-${status.id}`}>
                  <Input
                    id={`status-name-${status.id}`}
                    required
                    maxLength={60}
                    value={status.name}
                    onChange={(event) =>
                      updateStatus(status.id, { name: event.target.value })
                    }
                  />
                </Field>
                <Field
                  label="Category"
                  htmlFor={`status-category-${status.id}`}
                >
                  <Select
                    id={`status-category-${status.id}`}
                    value={status.category}
                    onChange={(event) =>
                      updateStatus(status.id, {
                        category: event.target.value as typeof status.category,
                      })
                    }
                  >
                    {issueStates.map((category) => (
                      <option key={category} value={category}>
                        {category[0]!.toUpperCase() + category.slice(1)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={status.archived}
                    onChange={(event) => {
                      setShowArchived(true);
                      updateStatus(status.id, {
                        archived: event.target.checked,
                      });
                    }}
                  />
                  Archived
                </label>
                <div className="flex gap-1">
                  {!existingIds.has(status.id) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove new status ${status.name || "untitled"}`}
                      onClick={() =>
                        onChange({
                          ...draft,
                          statuses: draft.statuses.filter(
                            (entry) => entry.id !== status.id,
                          ),
                          defaultStatusId:
                            draft.defaultStatusId === status.id
                              ? ""
                              : draft.defaultStatusId,
                        })
                      }
                    >
                      <X />
                    </Button>
                  )}
                  {[-1, 1].map((offset) => (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      key={offset}
                      aria-label={`Move ${status.name || "status"} ${offset < 0 ? "up" : "down"}`}
                      disabled={
                        index + offset < 0 ||
                        index + offset >= draft.statuses.length
                      }
                      onClick={() => {
                        const statuses = [...draft.statuses];
                        [statuses[index], statuses[index + offset]] = [
                          statuses[index + offset]!,
                          statuses[index]!,
                        ];
                        onChange({ ...draft, statuses });
                      }}
                    >
                      {offset < 0 ? <ArrowUp /> : <ArrowDown />}
                    </Button>
                  ))}
                </div>
              </div>
            </fieldset>
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={draft.statuses.length >= 100}
          onClick={() =>
            onChange({
              ...draft,
              statuses: [
                ...draft.statuses,
                {
                  id: crypto.randomUUID(),
                  name: "",
                  category: "backlog",
                  archived: false,
                },
              ],
            })
          }
        >
          <Plus />
          Add status
        </Button>
        {draft.statuses.some((status) => status.archived) && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
        )}
      </div>
    </>
  );
}
