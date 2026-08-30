"use client";

import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { api, jsonBody } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { SettingsProfile, SettingsProfileVersion } from "./types";

export function HistoryEditor({
  profile,
  onProfile,
  onError,
}: {
  profile: SettingsProfile;
  onProfile: (profile: SettingsProfile) => Promise<void>;
  onError: (message: string) => void;
}): React.ReactElement {
  const [versions, setVersions] = useState<SettingsProfileVersion[]>([]);
  useEffect(() => {
    void api<{ versions: SettingsProfileVersion[] }>(
      `/api/settings/profiles/${encodeURIComponent(profile.profileId)}/versions`,
    )
      .then((payload) => setVersions(payload.versions))
      .catch((reason: unknown) =>
        onError(
          reason instanceof Error
            ? reason.message
            : "History could not be loaded.",
        ),
      );
  }, [onError, profile.profileId, profile.revision]);
  return (
    <div className="grid gap-4">
      <h3 className="font-medium">History</h3>
      <div className="grid gap-2">
        {versions.map((version) => (
          <div
            key={version.revision}
            className="flex items-center gap-3 rounded-lg border border-border p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Revision {version.revision}</p>
              <p className="truncate text-xs text-muted-foreground">
                {version.changeSummary} · {formatTime(version.createdAt)}
              </p>
            </div>
            {version.revision !== profile.revision ? (
              <ConfirmButton
                destructive={false}
                trigger={
                  <Button variant="outline" size="sm">
                    <RotateCcw />
                    Restore
                  </Button>
                }
                title={`Restore revision ${version.revision}?`}
                description="Secret values will stay current."
                actionLabel="Restore revision"
                onConfirm={async () => {
                  const payload = await api<{ profile: SettingsProfile }>(
                    `/api/settings/profiles/${encodeURIComponent(profile.profileId)}/versions/${version.revision}/restore`,
                    {
                      method: "POST",
                      body: jsonBody({ expectedRevision: profile.revision }),
                    },
                  );
                  await onProfile(payload.profile);
                }}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
