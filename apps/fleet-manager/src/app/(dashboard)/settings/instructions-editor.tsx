"use client";

import { FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  ManagedInstruction,
  ManagedSettingsDocument,
  SettingsProfile,
} from "./types";
import { splitList } from "./types";

export function InstructionsEditor({
  profile,
  onSave,
}: {
  profile: SettingsProfile;
  onSave: (document: ManagedSettingsDocument, summary: string) => Promise<void>;
}): React.ReactElement {
  const [editing, setEditing] = useState<ManagedInstruction | "new" | null>(
    null,
  );
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Instructions</h3>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus />
          Add instruction
        </Button>
      </div>
      {profile.document.instructions.length ? (
        <div className="grid gap-2">
          {profile.document.instructions.map((instruction) => (
            <div
              key={instruction.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {instruction.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {instruction.enabled ? "Enabled" : "Disabled"}
                  {instruction.global ? " · Global" : ""}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${instruction.name}`}
                onClick={() => setEditing(instruction)}
              >
                <Pencil />
              </Button>
              <ConfirmButton
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${instruction.name}`}
                  >
                    <Trash2 />
                  </Button>
                }
                title={`Delete ${instruction.name}?`}
                description="The instruction will be removed from this profile."
                actionLabel="Delete instruction"
                onConfirm={() => {
                  const document = structuredClone(profile.document);
                  document.instructions = document.instructions.filter(
                    (item) => item.id !== instruction.id,
                  );
                  return onSave(document, "Deleted instruction");
                }}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No instructions.
        </p>
      )}
      <InstructionDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        editing={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSubmit={async (instruction) => {
          const document = structuredClone(profile.document);
          const index = document.instructions.findIndex(
            (item) => item.id === instruction.id,
          );
          if (index === -1) document.instructions.push(instruction);
          else document.instructions[index] = instruction;
          await onSave(
            document,
            index === -1 ? "Added instruction" : "Updated instruction",
          );
          setEditing(null);
        }}
      />
    </div>
  );
}

function InstructionDialog({
  editing,
  onOpenChange,
  onSubmit,
}: {
  editing: ManagedInstruction | "new" | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (instruction: ManagedInstruction) => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const instruction = editing === "new" ? null : editing;
  return (
    <Dialog open={editing !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>
          {instruction ? "Edit instruction" : "New instruction"}
        </DialogTitle>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setPending(true);
            void onSubmit({
              id: instruction?.id ?? crypto.randomUUID(),
              name: String(form.get("name")),
              body: String(form.get("body")),
              enabled: form.get("enabled") === "on",
              global: form.get("global") === "on",
              tags: splitList(String(form.get("tags"))),
            })
              .catch(() => undefined)
              .finally(() => setPending(false));
          }}
        >
          <Field label="Name" htmlFor="instruction-name">
            <Input
              id="instruction-name"
              name="name"
              defaultValue={instruction?.name ?? ""}
              required
              autoFocus
            />
          </Field>
          <Field label="Content" htmlFor="instruction-body">
            <Textarea
              id="instruction-body"
              name="body"
              className="min-h-64 font-mono text-xs"
              defaultValue={instruction?.body ?? ""}
              required
            />
          </Field>
          <Field
            label="Tags"
            htmlFor="instruction-tags"
            hint="Separate tags with commas."
          >
            <Input
              id="instruction-tags"
              name="tags"
              defaultValue={instruction?.tags.join(", ") ?? ""}
            />
          </Field>
          <div className="flex flex-wrap gap-5">
            <Checkbox
              name="enabled"
              label="Enabled"
              defaultChecked={instruction?.enabled ?? true}
            />
            <Checkbox
              name="global"
              label="Global"
              defaultChecked={instruction?.global ?? false}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save instruction"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Checkbox({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}): React.ReactElement {
  return (
    <label className="flex items-center gap-2 text-sm font-medium">
      <input
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        className="size-4 accent-primary"
      />
      {label}
    </label>
  );
}
