"use client";

import { Plus, Settings2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, jsonBody } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AssignmentsEditor } from "./assignments-editor";
import { ContextPacksEditor } from "./context-packs-editor";
import { HistoryEditor } from "./history-editor";
import { InstructionsEditor } from "./instructions-editor";
import { ProfileGeneral } from "./profile-general";
import { PromptsEditor } from "./prompts-editor";
import { SecretsEditor } from "./secrets-editor";
import type {
  ManagedSettingsDocument,
  SettingsAssignment,
  SettingsCatalog,
  SettingsProfile,
  SettingsProfileSummary,
  SettingsTab,
} from "./types";

const ASSIGNMENTS_REFRESH_MS = 10_000;

const tabs: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "instructions", label: "Instructions" },
  { id: "packs", label: "Context packs" },
  { id: "prompts", label: "Prompts" },
  { id: "secrets", label: "Secrets" },
  { id: "instances", label: "Instances" },
  { id: "history", label: "History" },
];

export function SettingsManager(): React.ReactElement {
  const [catalog, setCatalog] = useState<SettingsCatalog | null>(null);
  const [profiles, setProfiles] = useState<SettingsProfileSummary[]>([]);
  const [profile, setProfile] = useState<SettingsProfile | null>(null);
  const [assignments, setAssignments] = useState<SettingsAssignment[]>([]);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadAssignments = useCallback(async () => {
    const payload = await api<{ assignments: SettingsAssignment[] }>(
      "/api/settings/assignments",
    );
    setAssignments(payload.assignments);
  }, []);

  const loadProfiles = useCallback(async (): Promise<
    SettingsProfileSummary[]
  > => {
    const payload = await api<{ profiles: SettingsProfileSummary[] }>(
      "/api/settings/profiles",
    );
    setProfiles(payload.profiles);
    return payload.profiles;
  }, []);

  const selectProfile = useCallback(async (profileId: string) => {
    const payload = await api<{ profile: SettingsProfile }>(
      `/api/settings/profiles/${encodeURIComponent(profileId)}`,
    );
    setProfile(payload.profile);
  }, []);

  useEffect(() => {
    void Promise.all([
      api<SettingsCatalog>("/api/settings/catalog"),
      loadProfiles(),
      loadAssignments(),
    ])
      .then(async ([catalogPayload, profileItems]) => {
        setCatalog(catalogPayload);
        if (profileItems[0]) await selectProfile(profileItems[0].profileId);
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setLoading(false));
  }, [loadAssignments, loadProfiles, selectProfile]);

  useEffect(() => {
    if (tab !== "instances") return;
    let refreshInFlight = false;
    const refresh = (): void => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      void loadAssignments()
        .catch((reason: unknown) => setError(errorMessage(reason)))
        .finally(() => {
          refreshInFlight = false;
        });
    };
    refresh();
    const interval = window.setInterval(refresh, ASSIGNMENTS_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [loadAssignments, tab]);

  const acceptProfile = useCallback(
    async (nextProfile: SettingsProfile) => {
      setProfile(nextProfile);
      await Promise.all([loadProfiles(), loadAssignments()]);
    },
    [loadAssignments, loadProfiles],
  );

  const saveProfile = useCallback(
    async (
      document: ManagedSettingsDocument,
      changeSummary: string,
      details?: { name?: string; description?: string },
    ) => {
      if (!profile) return;
      setError("");
      try {
        const payload = await api<{ profile: SettingsProfile }>(
          `/api/settings/profiles/${encodeURIComponent(profile.profileId)}`,
          {
            method: "PUT",
            body: jsonBody({
              expectedRevision: profile.revision,
              name: details?.name ?? profile.name,
              description: details?.description ?? profile.description,
              document,
              changeSummary,
            }),
          },
        );
        await acceptProfile(payload.profile);
      } catch (reason) {
        setError(errorMessage(reason));
        if (reason instanceof ApiError && reason.status === 409) {
          await selectProfile(profile.profileId);
        }
        throw reason;
      }
    },
    [acceptProfile, profile, selectProfile],
  );

  return (
    <section className="grid gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <CreateProfile onCreated={acceptProfile} onError={setError} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid min-h-[620px] gap-4 lg:grid-cols-[230px_1fr]">
        <Card className="h-fit p-2">
          <div className="grid gap-1">
            {profiles.map((item) => (
              <button
                key={item.profileId}
                type="button"
                className={cn(
                  "rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted",
                  profile?.profileId === item.profileId &&
                    "bg-primary/10 text-primary",
                )}
                onClick={() =>
                  void selectProfile(item.profileId).catch((reason: unknown) =>
                    setError(errorMessage(reason)),
                  )
                }
              >
                <span className="block truncate text-sm font-medium">
                  {item.name}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Revision {item.revision}
                </span>
              </button>
            ))}
            {!loading && profiles.length === 0 ? (
              <div className="grid justify-items-center gap-3 px-3 py-8 text-center text-sm text-muted-foreground">
                <Settings2 className="size-5" />
                No profiles.
              </div>
            ) : null}
          </div>
        </Card>
        {profile && catalog ? (
          <Card className="min-w-0 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate font-semibold">{profile.name}</h2>
                <p className="text-xs text-muted-foreground">
                  Revision {profile.revision}
                </p>
              </div>
              <ConfirmButton
                trigger={
                  <Button
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
                  await api(
                    `/api/settings/profiles/${encodeURIComponent(profile.profileId)}`,
                    { method: "DELETE" },
                  );
                  setProfile(null);
                  const nextProfiles = await loadProfiles();
                  await loadAssignments();
                  if (nextProfiles[0])
                    await selectProfile(nextProfiles[0].profileId);
                }}
              />
            </div>
            <div className="flex overflow-x-auto border-b border-border px-3">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    "shrink-0 border-b-2 border-transparent px-3 py-3 text-sm text-muted-foreground",
                    tab === item.id && "border-primary text-foreground",
                  )}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="p-5 sm:p-6">
              {tab === "general" ? (
                <ProfileGeneral
                  key={`${profile.profileId}:${profile.revision}`}
                  profile={profile}
                  onSave={saveProfile}
                />
              ) : null}
              {tab === "instructions" ? (
                <InstructionsEditor profile={profile} onSave={saveProfile} />
              ) : null}
              {tab === "packs" ? (
                <ContextPacksEditor profile={profile} onSave={saveProfile} />
              ) : null}
              {tab === "prompts" ? (
                <PromptsEditor profile={profile} onSave={saveProfile} />
              ) : null}
              {tab === "secrets" ? (
                <SecretsEditor
                  profile={profile}
                  catalog={catalog}
                  onProfile={acceptProfile}
                  onError={setError}
                />
              ) : null}
              {tab === "instances" ? (
                <AssignmentsEditor
                  profiles={profiles}
                  assignments={assignments}
                  onRefresh={async () => {
                    await Promise.all([loadProfiles(), loadAssignments()]);
                  }}
                  onError={setError}
                />
              ) : null}
              {tab === "history" ? (
                <HistoryEditor
                  profile={profile}
                  onProfile={acceptProfile}
                  onError={setError}
                />
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </section>
  );
}

function CreateProfile({
  onCreated,
  onError,
}: {
  onCreated: (profile: SettingsProfile) => Promise<void>;
  onError: (error: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          New profile
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>New profile</DialogTitle>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setPending(true);
            void api<{ profile: SettingsProfile }>("/api/settings/profiles", {
              method: "POST",
              body: jsonBody({
                name: form.get("name"),
                description: form.get("description"),
              }),
            })
              .then(async ({ profile }) => {
                await onCreated(profile);
                setOpen(false);
              })
              .catch((reason: unknown) => onError(errorMessage(reason)))
              .finally(() => setPending(false));
          }}
        >
          <Field label="Name" htmlFor="profile-name">
            <Input id="profile-name" name="name" required autoFocus />
          </Field>
          <Field label="Description" htmlFor="profile-description">
            <Textarea id="profile-description" name="description" />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Settings request failed.";
}
