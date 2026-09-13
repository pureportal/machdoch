"use client";

import { Trash2 } from "lucide-react";
import { Tabs } from "radix-ui";
import { useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, ApiError, jsonBody } from "@/lib/api";
import { AssignmentsEditor } from "./assignments-editor";
import { ContextPacksEditor } from "./context-packs-editor";
import { HistoryEditor } from "./history-editor";
import { InstructionsEditor } from "./instructions-editor";
import { ProfileGeneral } from "./profile-general";
import { PromptsEditor } from "./prompts-editor";
import { SecretsEditor } from "./secrets-editor";
import type {
  ManagedSettingsDocument,
  SettingsCatalog,
  SettingsProfile,
  SettingsProfileSummary,
} from "./types";

export type UpdateProfile = (path: string, init: RequestInit) => Promise<void>;

const tabs = [
  ["general", "General"],
  ["instructions", "Instructions"],
  ["packs", "Context packs"],
  ["prompts", "Prompts"],
  ["secrets", "Secrets"],
  ["instances", "Instances"],
  ["history", "History"],
] as const;

export function ProfileEditor({
  profile,
  catalog,
  profiles,
  onProfile,
  onPendingChange,
  onDelete,
}: {
  profile: SettingsProfile;
  catalog: SettingsCatalog;
  profiles: SettingsProfileSummary[];
  onProfile: (profile: SettingsProfile) => void;
  onPendingChange: (pending: boolean) => void;
  onDelete: () => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const path = `/api/settings/profiles/${encodeURIComponent(profile.profileId)}`;
  const update: UpdateProfile = async (url, init) => {
    if (submitting.current)
      throw new Error("Wait for the current save to finish.");
    if (conflict) throw new Error("Reload the profile before saving again.");
    submitting.current = true;
    setPending(true);
    onPendingChange(true);
    try {
      const payload = await api<{ profile: SettingsProfile }>(url, init);
      onProfile(payload.profile);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409)
        setConflict(true);
      throw reason;
    } finally {
      submitting.current = false;
      setPending(false);
      onPendingChange(false);
    }
  };
  const save = (
    document: ManagedSettingsDocument,
    changeSummary: string,
    details?: { name?: string; description?: string },
  ) =>
    update(path, {
      method: "PUT",
      body: jsonBody({
        expectedRevision: profile.revision,
        name: details?.name ?? profile.name,
        description: details?.description ?? profile.description,
        document,
        changeSummary,
      }),
    });
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 ref={heading} tabIndex={-1} className="truncate font-semibold">
            {profile.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            Revision {profile.revision}
          </p>
        </div>
        <ConfirmButton
          trigger={
            <Button
              disabled={pending}
              variant="ghost"
              size="icon"
              aria-label={`Delete ${profile.name}`}
            >
              <Trash2 />
            </Button>
          }
          title={`Delete ${profile.name}?`}
          description="Assigned instances will stop receiving this profile."
          actionLabel="Delete profile"
          onConfirm={async () => {
            onPendingChange(true);
            try {
              await onDelete();
            } finally {
              onPendingChange(false);
            }
          }}
        />
      </div>
      {conflict ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <p role="alert" className="text-sm">
            This profile changed. Reload it before saving.
          </p>
          <ConfirmButton
            destructive={false}
            trigger={<Button variant="outline">Reload profile</Button>}
            title="Reload profile?"
            description="Unsaved changes in this profile will be discarded."
            actionLabel="Reload profile"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              heading.current?.focus();
            }}
            onConfirm={async () => {
              const payload = await api<{ profile: SettingsProfile }>(path);
              onProfile(payload.profile);
              setConflict(false);
              setReloadCount((value) => value + 1);
            }}
          />
        </div>
      ) : null}
      <Tabs.Root key={reloadCount} defaultValue="general">
        <Tabs.List
          aria-label="Profile settings"
          className="flex overflow-x-auto border-b border-border px-3"
        >
          {tabs.map(([id, label]) => (
            <Tabs.Trigger
              key={id}
              value={id}
              disabled={pending}
              className="shrink-0 border-b-2 border-transparent px-3 py-3 text-sm text-muted-foreground outline-offset-[-3px] data-[state=active]:border-primary data-[state=active]:text-foreground disabled:opacity-50"
              onFocus={(event) =>
                event.currentTarget.scrollIntoView({
                  block: "nearest",
                  inline: "nearest",
                })
              }
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div className="p-4 sm:p-6">
          <Tabs.Content value="general">
            <ProfileGeneral
              key={profile.revision}
              profile={profile}
              onSave={save}
            />
          </Tabs.Content>
          <Tabs.Content value="instructions">
            <InstructionsEditor profile={profile} onSave={save} />
          </Tabs.Content>
          <Tabs.Content value="packs">
            <ContextPacksEditor profile={profile} onSave={save} />
          </Tabs.Content>
          <Tabs.Content value="prompts">
            <PromptsEditor profile={profile} onSave={save} />
          </Tabs.Content>
          <Tabs.Content value="secrets">
            <fieldset disabled={pending} className="min-w-0">
              <SecretsEditor
                profile={profile}
                catalog={catalog}
                onUpdate={update}
              />
            </fieldset>
          </Tabs.Content>
          <Tabs.Content value="instances">
            <AssignmentsEditor
              profiles={profiles}
              onPendingChange={(value) => {
                setPending(value);
                onPendingChange(value);
              }}
            />
          </Tabs.Content>
          <Tabs.Content value="history">
            <HistoryEditor profile={profile} onUpdate={update} />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </Card>
  );
}
