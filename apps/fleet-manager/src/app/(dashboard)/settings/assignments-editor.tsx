"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { api, jsonBody } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { SettingsAssignment, SettingsProfileSummary } from "./types";
import { settingsError } from "./use-settings-profiles";

export function AssignmentsEditor({
  profiles,
  onPendingChange,
}: {
  profiles: SettingsProfileSummary[];
  onPendingChange: (pending: boolean) => void;
}): React.ReactElement {
  const [assignments, setAssignments] = useState<SettingsAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<{
    instanceId: string;
    profileId: string | null;
  } | null>(null);
  const submitting = useRef(false);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const payload = await api<{ assignments: SettingsAssignment[] }>(
        "/api/settings/assignments",
      );
      if (request !== requestId.current) return;
      setAssignments(payload.assignments);
      setError("");
    } catch (reason) {
      if (request === requestId.current) setError(settingsError(reason));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: number;
    const refresh = async (): Promise<void> => {
      if (!submitting.current) await load();
      if (!stopped) timer = window.setTimeout(() => void refresh(), 10_000);
    };
    void refresh();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      requestId.current++;
    };
  }, [load]);
  const assign = async (
    instanceId: string,
    profileId: string | null,
  ): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true;
    onPendingChange(true);
    requestId.current++;
    setPending({ instanceId, profileId });
    setActionError("");
    try {
      await api(
        `/api/settings/instances/${encodeURIComponent(instanceId)}/assignment`,
        { method: "PUT", body: jsonBody({ profileId }) },
      );
      const profile = profiles.find((item) => item.profileId === profileId);
      setAssignments((current) =>
        current.map((item) =>
          item.instanceId === instanceId
            ? {
                ...item,
                profileId,
                profileName: profile?.name ?? null,
                profileRevision: profile?.revision ?? null,
                syncStatus: profileId ? "pending" : "unassigned",
                syncError: null,
              }
            : item,
        ),
      );
      await load();
    } catch (reason) {
      setActionError(settingsError(reason));
    } finally {
      submitting.current = false;
      setPending(null);
      onPendingChange(false);
    }
  };
  return (
    <div className="grid gap-4">
      <h3 className="font-medium">Instances</h3>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading instances…
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
      {actionError ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      {assignments.map((assignment) => (
        <div
          key={assignment.instanceId}
          className="grid min-w-0 gap-3 rounded-lg border border-border p-4 xl:grid-cols-[minmax(0,1fr)_220px] xl:items-center"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 break-words text-sm font-medium">
                {assignment.displayName}
              </p>
              <Badge variant={assignment.instanceStatus}>
                {assignment.instanceStatus}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {syncSummary(assignment)}
            </p>
            {assignment.syncError ? (
              <p
                role="alert"
                className="mt-1 break-words text-xs text-destructive"
              >
                {assignment.syncError}
              </p>
            ) : null}
          </div>
          <Select
            value={
              (pending?.instanceId === assignment.instanceId
                ? pending.profileId
                : assignment.profileId) ?? ""
            }
            disabled={
              assignment.instanceStatus === "revoked" ||
              Boolean(pending) ||
              Boolean(error)
            }
            aria-label={`Profile for ${assignment.displayName}`}
            onChange={(event) =>
              void assign(assignment.instanceId, event.target.value || null)
            }
          >
            <option value="">Not assigned</option>
            {profiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>
                {profile.name}
              </option>
            ))}
          </Select>
        </div>
      ))}
      {!loading && !error && !assignments.length ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No instances.
        </p>
      ) : null}
    </div>
  );
}

function syncSummary(assignment: SettingsAssignment): string {
  if (assignment.syncStatus === "unassigned") return "Not assigned";
  if (assignment.syncStatus === "failed")
    return `Sync failed · ${formatTime(assignment.lastSyncAttemptAt)}`;
  if (assignment.syncStatus === "applied")
    return `Revision ${assignment.profileRevision} applied · ${formatTime(assignment.lastAppliedAt)}`;
  if (assignment.lastAppliedRevision !== null)
    return `Revision ${assignment.profileRevision} pending · Last applied ${assignment.lastAppliedRevision}`;
  return `Revision ${assignment.profileRevision} pending`;
}
