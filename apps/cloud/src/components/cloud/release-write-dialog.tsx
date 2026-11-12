"use client";

import { useEffect, useRef, useState } from "react";
import type { CloudProviderSettings } from "@machdoch/fleet-protocol/cloud-providers";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cloudRequest, createCommandSender, formText } from "./api-client";
import type { StudioContext } from "./release-studio";

const scopes = [
  ["all", "Notes, posts and visuals"],
  ["notes", "Release notes only"],
  ["posts", "Posts and visuals only"],
] as const;

export function ReleaseWriteDialog({
  context,
  channel,
  onClose,
  onStarted,
}: {
  context: StudioContext;
  channel?: { id: string; name: string };
  onClose: () => void;
  onStarted: () => Promise<void>;
}) {
  const sender = useRef(createCommandSender());
  const [models, setModels] = useState<
    { value: string; label: string }[] | null
  >(null);
  useEffect(() => {
    const abort = new AbortController();
    cloudRequest<CloudProviderSettings>("ai-providers", {
      signal: abort.signal,
    })
      .then((settings) =>
        setModels(
          settings.providers
            .filter((provider) => provider.enabled)
            .flatMap((provider) =>
              provider.models.map((model) => ({
                value: `${provider.id}/${model}`,
                label: `${provider.name} · ${model}`,
              })),
            ),
        ),
      )
      .catch(() => setModels([]));
    return () => abort.abort();
  }, []);
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={channel ? `Rewrite ${channel.name} post` : "Write with Agent"}
      submitLabel="Start writing"
      submitDisabled={!models?.length}
      onSubmit={async (form) => {
        const [providerId, ...model] = formText(form, "model").split("/");
        await sender.current(`releases/${context.release.id}/write`, {
          providerId,
          model: model.join("/"),
          scope: channel ? "posts" : formText(form, "scope"),
          channelIds: channel ? [channel.id] : [],
          instructions: formText(form, "instructions"),
        });
        await onStarted();
      }}
    >
      {models && !models.length && (
        <p role="alert" className="text-sm text-destructive">
          Add an AI provider first.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model" htmlFor="write-model">
          <Select id="write-model" name="model" disabled={!models?.length}>
            {models?.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
          </Select>
        </Field>
        {!channel && (
          <Field label="Write" htmlFor="write-scope">
            <Select id="write-scope" name="scope" defaultValue="all">
              {scopes.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <Field label="Instructions" htmlFor="write-instructions">
        <Textarea
          id="write-instructions"
          name="instructions"
          rows={3}
          maxLength={2_000}
          placeholder="Focus on the release studio. Mention the free plan."
        />
      </Field>
    </FormDialog>
  );
}
