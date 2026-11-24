"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  projectStatuses,
  type ProjectStatusCategory,
} from "@/lib/cloud-contract";
import type { CloudProjectStatus } from "@/lib/cloud-project-status-contract";
import { projectStatusLabels } from "@/lib/project-status";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cloudRequest, createCommandSender, formText } from "./api-client";

type Editing =
  | { kind: "create"; category: ProjectStatusCategory }
  | { kind: "rename"; status: CloudProjectStatus }
  | { kind: "delete"; status: CloudProjectStatus };

export function ProjectStatusManager({
  statuses,
  writable,
}: {
  statuses: CloudProjectStatus[];
  writable: boolean;
}) {
  const router = useRouter();
  const sender = useRef(createCommandSender());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState("");
  function edit(next: Editing) {
    sender.current = createCommandSender();
    setEditing(next);
  }
  async function swap(first: CloudProjectStatus, second: CloudProjectStatus) {
    try {
      await cloudRequest(`project-statuses/${first.id}`, {
        method: "PATCH",
        body: { name: first.name, position: second.position },
      });
      await cloudRequest(`project-statuses/${second.id}`, {
        method: "PATCH",
        body: { name: second.name, position: first.position },
      });
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
    router.refresh();
  }
  return (
    <div className="cloud-settings">
      {error && (
        <p role="alert" className="cloud-error">
          {error}
        </p>
      )}
      {projectStatuses.map((category) => {
        const group = statuses.filter((status) => status.category === category);
        return (
          <section
            key={category}
            className="cloud-settings-section"
            aria-label={projectStatusLabels[category]}
          >
            <header>
              <h2>{projectStatusLabels[category]}</h2>
              {writable && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => edit({ kind: "create", category })}
                >
                  <Plus />
                  New status
                </Button>
              )}
            </header>
            <ul className="cloud-setting-list">
              {group.map((status, index) => (
                <li key={status.id}>
                  {writable ? (
                    <button
                      type="button"
                      aria-label={`Rename ${status.name}`}
                      onClick={() => edit({ kind: "rename", status })}
                    >
                      <span>{status.name}</span>
                    </button>
                  ) : (
                    <span>{status.name}</span>
                  )}
                  {writable && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Move ${status.name} up`}
                        disabled={index === 0}
                        onClick={() => void swap(status, group[index - 1]!)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Move ${status.name} down`}
                        disabled={index === group.length - 1}
                        onClick={() => void swap(status, group[index + 1]!)}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${status.name}`}
                        disabled={group.length === 1}
                        onClick={() => edit({ kind: "delete", status })}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={
          editing?.kind === "create"
            ? `New ${projectStatusLabels[editing.category]} status`
            : editing?.kind === "delete"
              ? `Delete ${editing.status.name}`
              : "Rename status"
        }
        submitLabel={
          editing?.kind === "create"
            ? "Create status"
            : editing?.kind === "delete"
              ? "Delete status"
              : "Save status"
        }
        onSubmit={async (form) => {
          if (!editing) return;
          if (editing.kind === "create")
            await sender.current("project-statuses", {
              name: formText(form, "name"),
              category: editing.category,
            });
          else if (editing.kind === "rename")
            await sender.current(
              `project-statuses/${editing.status.id}`,
              {
                name: formText(form, "name"),
                position: editing.status.position,
              },
              "PATCH",
            );
          else
            await sender.current(
              `project-statuses/${editing.status.id}`,
              { replacementId: formText(form, "replacementId") },
              "DELETE",
            );
          router.refresh();
        }}
      >
        {editing?.kind === "delete" ? (
          <Field label="Move projects to" htmlFor="project-status-replacement">
            <Select
              id="project-status-replacement"
              name="replacementId"
              required
            >
              {statuses
                .filter((status) => status.id !== editing.status.id)
                .map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
            </Select>
          </Field>
        ) : (
          <Field label="Name" htmlFor="project-status-name">
            <Input
              id="project-status-name"
              name="name"
              required
              maxLength={60}
              defaultValue={
                editing?.kind === "rename" ? editing.status.name : undefined
              }
            />
          </Field>
        )}
      </FormDialog>
    </div>
  );
}
