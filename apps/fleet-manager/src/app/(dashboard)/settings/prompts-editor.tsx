"use client";

import { FileCode2, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { SettingsFormDialog } from "./settings-form-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  ManagedPrompt,
  ManagedSettingsDocument,
  SettingsProfile,
} from "./types";

export function PromptsEditor({
  profile,
  onSave,
}: {
  profile: SettingsProfile;
  onSave: (document: ManagedSettingsDocument, summary: string) => Promise<void>;
}): React.ReactElement {
  const [editing, setEditing] = useState<ManagedPrompt | "new" | null>(null);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Prompts</h3>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus />
          Add prompt
        </Button>
      </div>
      {profile.document.prompts.length ? (
        <div className="grid gap-2">
          {profile.document.prompts.map((prompt) => (
            <div
              key={prompt.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 truncate font-mono text-sm">
                {prompt.relativePath}
              </p>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${prompt.relativePath}`}
                onClick={() => setEditing(prompt)}
              >
                <Pencil />
              </Button>
              <ConfirmButton
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${prompt.relativePath}`}
                  >
                    <Trash2 />
                  </Button>
                }
                title={`Delete ${prompt.relativePath}?`}
                description="The prompt will be removed from this profile."
                actionLabel="Delete prompt"
                onConfirm={() => {
                  const document = structuredClone(profile.document);
                  document.prompts = document.prompts.filter(
                    (item) => item.id !== prompt.id,
                  );
                  return onSave(document, "Deleted prompt");
                }}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No prompts.
        </p>
      )}
      <PromptDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        editing={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSubmit={async (prompt) => {
          const document = structuredClone(profile.document);
          const index = document.prompts.findIndex(
            (item) => item.id === prompt.id,
          );
          if (index === -1) document.prompts.push(prompt);
          else document.prompts[index] = prompt;
          await onSave(
            document,
            index === -1 ? "Added prompt" : "Updated prompt",
          );
          setEditing(null);
        }}
      />
    </div>
  );
}

function PromptDialog({
  editing,
  onOpenChange,
  onSubmit,
}: {
  editing: ManagedPrompt | "new" | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (prompt: ManagedPrompt) => Promise<void>;
}): React.ReactElement {
  const prompt = editing === "new" ? null : editing;
  return (
    <SettingsFormDialog
      open={editing !== null}
      onOpenChange={onOpenChange}
      title={prompt ? "Edit prompt" : "New prompt"}
      submitLabel="Save prompt"
      onSubmit={(form) =>
        onSubmit({
          id: prompt?.id ?? crypto.randomUUID(),
          relativePath: String(form.get("relativePath")),
          content: String(form.get("content")),
        })
      }
    >
      <Field label="Path" htmlFor="prompt-path">
        <Input
          id="prompt-path"
          name="relativePath"
          defaultValue={prompt?.relativePath ?? ""}
          placeholder="review.prompt.md"
          required
        />
      </Field>
      <Field label="Content" htmlFor="prompt-content">
        <Textarea
          id="prompt-content"
          name="content"
          className="min-h-72 font-mono text-xs"
          defaultValue={prompt?.content ?? ""}
          required
        />
      </Field>
    </SettingsFormDialog>
  );
}
