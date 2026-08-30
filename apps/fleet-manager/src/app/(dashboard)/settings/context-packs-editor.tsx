"use client";

import { Boxes, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  ManagedContextPack,
  ManagedSettingsDocument,
  SettingsProfile,
} from "./types";
import { optionalValue, splitList } from "./types";

const providers = [
  "openai",
  "anthropic",
  "google",
  "langdock",
  "quiver",
  "codex-cli",
  "claude-cli",
  "copilot-cli",
];
const reasoning = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function ContextPacksEditor({
  profile,
  onSave,
}: {
  profile: SettingsProfile;
  onSave: (document: ManagedSettingsDocument, summary: string) => Promise<void>;
}): React.ReactElement {
  const [editing, setEditing] = useState<ManagedContextPack | "new" | null>(
    null,
  );
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Context packs</h3>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus />
          Add context pack
        </Button>
      </div>
      {profile.document.contextPacks.length ? (
        <div className="grid gap-2">
          {profile.document.contextPacks.map((pack) => (
            <div
              key={pack.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <Boxes className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{pack.name}</p>
                <p className="text-xs text-muted-foreground">
                  {pack.provider ?? "Default provider"}
                  {pack.model ? ` · ${pack.model}` : ""}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${pack.name}`}
                onClick={() => setEditing(pack)}
              >
                <Pencil />
              </Button>
              <ConfirmButton
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${pack.name}`}
                  >
                    <Trash2 />
                  </Button>
                }
                title={`Delete ${pack.name}?`}
                description="The context pack will be removed from this profile."
                actionLabel="Delete context pack"
                onConfirm={() => {
                  const document = structuredClone(profile.document);
                  document.contextPacks = document.contextPacks.filter(
                    (item) => item.id !== pack.id,
                  );
                  return onSave(document, "Deleted context pack");
                }}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No context packs.
        </p>
      )}
      <ContextPackDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        editing={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSubmit={async (pack) => {
          const document = structuredClone(profile.document);
          const index = document.contextPacks.findIndex(
            (item) => item.id === pack.id,
          );
          if (index === -1) document.contextPacks.push(pack);
          else document.contextPacks[index] = pack;
          await onSave(
            document,
            index === -1 ? "Added context pack" : "Updated context pack",
          );
          setEditing(null);
        }}
      />
    </div>
  );
}

function ContextPackDialog({
  editing,
  onOpenChange,
  onSubmit,
}: {
  editing: ManagedContextPack | "new" | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (pack: ManagedContextPack) => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const pack = editing === "new" ? null : editing;
  return (
    <Dialog open={editing !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>
          {pack ? "Edit context pack" : "New context pack"}
        </DialogTitle>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setPending(true);
            void onSubmit({
              id: pack?.id ?? crypto.randomUUID(),
              name: String(form.get("name")),
              instructions: String(form.get("instructions")),
              prompt: String(form.get("prompt")),
              provider: optionalValue(String(form.get("provider"))),
              model: optionalValue(String(form.get("model"))),
              mode: optionalValue(String(form.get("mode"))),
              reasoning: optionalValue(String(form.get("reasoning"))),
              variables: splitList(String(form.get("variables"))),
              triggerPhrases: splitList(String(form.get("triggerPhrases"))),
              pathPatterns: splitList(String(form.get("pathPatterns"))),
            })
              .catch(() => undefined)
              .finally(() => setPending(false));
          }}
        >
          <Field label="Name" htmlFor="pack-name">
            <Input
              id="pack-name"
              name="name"
              defaultValue={pack?.name ?? ""}
              required
              autoFocus
            />
          </Field>
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Instructions" htmlFor="pack-instructions">
              <Textarea
                id="pack-instructions"
                name="instructions"
                className="min-h-36"
                defaultValue={pack?.instructions ?? ""}
              />
            </Field>
            <Field label="Prompt" htmlFor="pack-prompt">
              <Textarea
                id="pack-prompt"
                name="prompt"
                className="min-h-36"
                defaultValue={pack?.prompt ?? ""}
              />
            </Field>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <OptionField
              label="Provider"
              name="provider"
              value={pack?.provider ?? null}
              options={providers}
            />
            <Field label="Model" htmlFor="pack-model">
              <Input
                id="pack-model"
                name="model"
                defaultValue={pack?.model ?? ""}
              />
            </Field>
            <OptionField
              label="Mode"
              name="mode"
              value={pack?.mode ?? null}
              options={["ask", "machdoch"]}
            />
            <OptionField
              label="Reasoning"
              name="reasoning"
              value={pack?.reasoning ?? null}
              options={reasoning}
            />
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            <ListField
              label="Variables"
              name="variables"
              value={pack?.variables ?? []}
            />
            <ListField
              label="Trigger phrases"
              name="triggerPhrases"
              value={pack?.triggerPhrases ?? []}
            />
            <ListField
              label="Path patterns"
              name="pathPatterns"
              value={pack?.pathPatterns ?? []}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save context pack"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OptionField({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value: string | null;
  options: string[];
}): React.ReactElement {
  return (
    <Field label={label} htmlFor={`pack-${name}`}>
      <Select id={`pack-${name}`} name={name} defaultValue={value ?? ""}>
        <option value="">Not set</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function ListField({
  label,
  name,
  value,
}: {
  label: string;
  name: string;
  value: string[];
}): React.ReactElement {
  return (
    <Field
      label={label}
      htmlFor={`pack-${name}`}
      hint="Separate values with commas."
    >
      <Input id={`pack-${name}`} name={name} defaultValue={value.join(", ")} />
    </Field>
  );
}
