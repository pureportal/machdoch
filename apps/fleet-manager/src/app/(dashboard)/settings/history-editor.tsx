"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { api, jsonBody } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { UpdateProfile } from "./profile-editor";
import type { SettingsProfile, SettingsProfileVersion } from "./types";
import { settingsError } from "./use-settings-profiles";

export function HistoryEditor({
  profile,
  onUpdate,
}: {
  profile: SettingsProfile;
  onUpdate: UpdateProfile;
}): React.ReactElement {
  const [versions, setVersions] = useState<SettingsProfileVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const path = `/api/settings/profiles/${encodeURIComponent(profile.profileId)}/versions`;
  const load = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const payload = await api<{ versions: SettingsProfileVersion[] }>(path);
      if (request === requestId.current) setVersions(payload.versions);
    } catch (reason) {
      if (request === requestId.current) setError(settingsError(reason));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load, profile.revision]);
  return (
    <div className="grid gap-4">
      <h3 className="font-medium">History</h3>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading history…
        </p>
      ) : null}
      {error ? (
        <div className="grid justify-items-start gap-3">
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}
      {!loading && !error && !versions.length ? (
        <p className="text-sm text-muted-foreground">No history.</p>
      ) : null}
      <div className="grid gap-2">
        {versions.map((version) => (
          <div
            key={version.revision}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Revision {version.revision}</p>
              <p className="break-words text-xs text-muted-foreground">
                {version.changeSummary} · {formatTime(version.createdAt)}
              </p>
            </div>
            {version.revision !== profile.revision ? (
              <ConfirmButton
                destructive={false}
                trigger={
                  <Button
                    disabled={loading || Boolean(error)}
                    variant="outline"
                    size="sm"
                  >
                    <RotateCcw />
                    Restore
                  </Button>
                }
                title={`Restore revision ${version.revision}?`}
                description="Profile settings will be restored. Secret values will stay current."
                actionLabel="Restore revision"
                onConfirm={() =>
                  onUpdate(`${path}/${version.revision}/restore`, {
                    method: "POST",
                    body: jsonBody({ expectedRevision: profile.revision }),
                  })
                }
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
