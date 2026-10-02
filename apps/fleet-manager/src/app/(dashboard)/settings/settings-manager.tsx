"use client";

import { Settings2 } from "lucide-react";
import { useCallback, useReducer, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CreateProfile } from "./create-profile";
import { ProfileEditor } from "./profile-editor";
import { profileDraftsReducer } from "./profile-drafts";
import type { SettingsProfile } from "./types";
import { useSettingsProfiles } from "./use-settings-profiles";

export function SettingsManager(): React.ReactElement {
  const [drafts, dispatchDraft] = useReducer(profileDraftsReducer, {});
  const onLoaded = useCallback((profile: SettingsProfile) => {
    dispatchDraft({ type: "loaded", profile });
  }, []);
  const onDeleted = useCallback((profileId: string) => {
    dispatchDraft({ type: "deleted", profileId });
  }, []);
  const state = useSettingsProfiles({ onLoaded, onDeleted });
  const generalDraft = state.profile
    ? drafts[state.profile.profileId]
    : undefined;
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const profiles = state.profiles.filter((profile) =>
    profile.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="grid min-w-0 gap-6">
      <PageHeader title="Settings">
        <CreateProfile
          disabled={!state.catalog || state.loading || pending}
          onCreated={state.acceptProfile}
        />
      </PageHeader>
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
      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[200px_minmax(0,1fr)]">
        {state.profiles.length ? (
          <Select
            className="xl:hidden"
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
            "h-fit min-w-0 p-2 xl:sticky xl:top-6",
            state.profiles.length && "hidden xl:block",
          )}
        >
          <div className="grid gap-3 px-2 pb-3 pt-2">
            <h2 className="text-sm font-semibold">Profiles</h2>
            {state.profiles.length > 5 ? (
              <Input
                type="search"
                aria-label="Search profiles"
                placeholder="Search profiles"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            ) : null}
          </div>
          <div
            className="grid max-h-[70dvh] gap-1 overflow-y-auto overscroll-contain"
            aria-label="Profiles"
          >
            {profiles.map((item) => (
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
              </button>
            ))}
            {!state.loading && !state.error && !state.profiles.length ? (
              <div className="grid justify-items-center gap-3 px-3 py-8 text-center text-sm text-muted-foreground">
                <Settings2 className="size-5" />
                No profiles.
              </div>
            ) : null}
            {state.profiles.length > 0 && profiles.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground" role="status">
                No matching profiles.
              </p>
            ) : null}
          </div>
        </Card>
        {state.loading ? (
          <p role="status" className="p-5 text-sm text-muted-foreground">
            Loading settings…
          </p>
        ) : null}
        {state.profile && state.catalog && generalDraft ? (
          <ProfileEditor
            key={state.profile.profileId}
            profile={state.profile}
            generalDraft={generalDraft}
            onGeneralChange={(draft, values) =>
              dispatchDraft({ type: "changed", draft, values })
            }
            onGeneralSaved={(profile) =>
              dispatchDraft({ type: "saved", profile })
            }
            onReloaded={(profile) =>
              dispatchDraft({ type: "reloaded", profile })
            }
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
