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
  const [provider, setProvider] = useState(pack?.provider ?? "");
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
              variables: parseVariables(String(form.get("variables"))),
              triggerPhrases: splitList(String(form.get("triggerPhrases"))),
              pathPatterns: splitList(String(form.get("pathPatterns"))),
              promptEnhancementMode: optionalValue(
                String(form.get("promptEnhancementMode")),
              ) as ManagedContextPack["promptEnhancementMode"],
              interviewEnabled: optionalBoolean(form, "interviewEnabled"),
              sessionMemoryEnabled: optionalBoolean(
                form,
                "sessionMemoryEnabled",
              ),
              useGlobalMemory: optionalBoolean(form, "useGlobalMemory"),
              uiControlEnabled: optionalBoolean(form, "uiControlEnabled"),
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
            <Field label="Provider" htmlFor="pack-provider">
              <Select
                id="pack-provider"
                name="provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="">Not set</option>
                {providers.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model" htmlFor="pack-model">
              <Input
                id="pack-model"
                name="model"
                defaultValue={pack?.model ?? ""}
                disabled={!provider}
                required={Boolean(provider)}
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
            <Field
              label="Variables"
              htmlFor="pack-variables"
              hint="One per line: NAME or NAME=default."
            >
              <Textarea
                id="pack-variables"
                name="variables"
                defaultValue={formatVariables(pack?.variables ?? [])}
              />
            </Field>
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
          <div className="grid gap-5 md:grid-cols-3">
            <OptionField
              label="Prompt enhancement"
              name="promptEnhancementMode"
              value={pack?.promptEnhancementMode ?? null}
              options={["off", "simple", "web-search"]}
            />
            <BooleanOptionField
              label="Interview"
              name="interviewEnabled"
              value={pack?.interviewEnabled ?? null}
            />
            <BooleanOptionField
              label="Session memory"
              name="sessionMemoryEnabled"
              value={pack?.sessionMemoryEnabled ?? null}
            />
            <BooleanOptionField
              label="Global memory"
              name="useGlobalMemory"
              value={pack?.useGlobalMemory ?? null}
            />
            <BooleanOptionField
              label="UI control"
              name="uiControlEnabled"
              value={pack?.uiControlEnabled ?? null}
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

function BooleanOptionField({
  label,
  name,
  value,
}: {
  label: string;
  name: string;
  value: boolean | null;
}): React.ReactElement {
  return (
    <Field label={label} htmlFor={`pack-${name}`}>
      <Select
        id={`pack-${name}`}
        name={name}
        defaultValue={value === null ? "" : String(value)}
      >
        <option value="">Not set</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </Select>
    </Field>
  );
}

function optionalBoolean(form: FormData, name: string): boolean | null {
  const value = form.get(name);
  return value === "" ? null : value === "true";
}

function parseVariables(value: string): ManagedContextPack["variables"] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      return separator === -1
        ? { name: entry, defaultValue: null }
        : {
            name: entry.slice(0, separator).trim(),
            defaultValue: entry.slice(separator + 1),
          };
    });
}

function formatVariables(variables: ManagedContextPack["variables"]): string {
  return variables
    .map((variable) =>
      variable.defaultValue === null
        ? variable.name
        : `${variable.name}=${variable.defaultValue}`,
    )
    .join("\n");
}
