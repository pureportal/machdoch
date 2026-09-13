"use client";

import { Settings2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { CreateProfile } from "./create-profile";
import { ProfileEditor } from "./profile-editor";
import { useSettingsProfiles } from "./use-settings-profiles";

export function SettingsManager(): React.ReactElement {
  const state = useSettingsProfiles();
  const [pending, setPending] = useState(false);
  return (
    <section className="grid min-w-0 gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <CreateProfile
          disabled={!state.catalog || state.loading || pending}
          onCreated={state.acceptProfile}
        />
      </div>
      {state.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="break-words text-sm text-destructive">
            {state.error}
          </p>
          <Button variant="outline" onClick={() => void state.retry()}>
            Retry
          </Button>
        </div>
      ) : null}
      <div className="grid min-w-0 gap-4 lg:min-h-[620px] lg:grid-cols-[230px_minmax(0,1fr)]">
        {state.profiles.length ? (
          <Select
            className="lg:hidden"
            aria-label="Profile"
            value={state.selectedId ?? ""}
            disabled={pending}
            onChange={(event) => void state.selectProfile(event.target.value)}
          >
            {state.profiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>
                {profile.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Card
          className={cn(
            "h-fit min-w-0 p-2",
            state.profiles.length && "hidden lg:block",
          )}
        >
          <div className="grid gap-1" aria-label="Profiles">
            {state.profiles.map((item) => (
              <button
                key={item.profileId}
                type="button"
                disabled={pending}
                aria-pressed={state.selectedId === item.profileId}
                className={cn(
                  "min-w-0 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted disabled:opacity-50",
                  state.selectedId === item.profileId &&
                    "bg-primary/10 text-primary",
                )}
                onClick={() => {
                  if (state.selectedId !== item.profileId)
                    void state.selectProfile(item.profileId);
                }}
              >
                <span className="block truncate text-sm font-medium">
                  {item.name}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Revision {item.revision}
                </span>
              </button>
            ))}
            {!state.loading && !state.error && !state.profiles.length ? (
              <div className="grid justify-items-center gap-3 px-3 py-8 text-center text-sm text-muted-foreground">
                <Settings2 className="size-5" />
                No profiles.
              </div>
            ) : null}
          </div>
        </Card>
        {state.loading ? (
          <p role="status" className="p-5 text-sm text-muted-foreground">
            Loading settings…
          </p>
        ) : null}
        {state.profile && state.catalog ? (
          <ProfileEditor
            key={state.profile.profileId}
            profile={state.profile}
            catalog={state.catalog}
            profiles={state.profiles}
            onProfile={state.acceptProfile}
            onPendingChange={setPending}
            onDelete={state.deleteProfile}
          />
        ) : null}
      </div>
    </section>
  );
}
