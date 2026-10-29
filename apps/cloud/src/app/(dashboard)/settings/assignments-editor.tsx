"use client";

import { ArrowDown, ArrowUp, Camera, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { formatTime } from "@/lib/format";
import type {
  SettingsAssignment,
  SettingsAssignmentLayer,
  SettingsProfileSummary,
} from "./types";
import { settingsError } from "./use-settings-profiles";

export function AssignmentsEditor({
  profiles,
  maximumLayers,
  onPendingChange,
}: {
  profiles: SettingsProfileSummary[];
  maximumLayers: number;
  onPendingChange: (pending: boolean) => void;
}): React.ReactElement {
  const [assignments, setAssignments] = useState<SettingsAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
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
  const run = async (
    instanceId: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true;
    onPendingChange(true);
    requestId.current++;
    setPending(instanceId);
    setActionError("");
    try {
      await action();
      await load();
    } catch (reason) {
      setActionError(settingsError(reason));
    } finally {
      submitting.current = false;
      setPending(null);
      onPendingChange(false);
    }
  };
  const assign = (instanceId: string, profileIds: string[]) =>
    run(instanceId, async () => {
      await api(
        `/api/settings/instances/${encodeURIComponent(instanceId)}/assignment`,
        { method: "PUT", body: jsonBody({ profileIds }) },
      );
    });
  const refreshSnapshot = (instanceId: string) =>
    run(instanceId, async () => {
      await api(
        `/api/settings/instances/${encodeURIComponent(instanceId)}/snapshot/refresh`,
        { method: "POST", body: jsonBody({}) },
      );
    });
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="font-medium">Instances</h3>
        <p className="text-sm text-muted-foreground">
          Assign up to {maximumLayers} profiles per device. Profiles higher in
          the list win, and enforced values beat defaults from any profile.
          Devices on older Machdoch versions only receive the first profile.
        </p>
      </div>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading devices…
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
      {assignments.map((assignment) => {
        const ids = assignment.layers.map((layer) => layer.profileId);
        const revoked = assignment.instanceStatus === "revoked";
        // A failed refresh leaves the list stale; act on it only after a retry.
        const disabled = revoked || Boolean(pending) || Boolean(error);
        const available = profiles.filter(
          (profile) => !ids.includes(profile.profileId),
        );
        const full = assignment.layers.length >= maximumLayers;
        const move = (index: number, offset: number) => {
          const next = [...ids];
          const [moved] = next.splice(index, 1);
          next.splice(index + offset, 0, moved!);
          void assign(assignment.instanceId, next);
        };
        return (
          <section
            key={assignment.instanceId}
            aria-label={assignment.displayName}
            className="grid min-w-0 gap-3 rounded-lg border border-border p-4"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
              {/* The basis lets the snapshot button wrap below on narrow screens. */}
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
                    {assignment.displayName}
                  </p>
                  <Badge variant={assignment.instanceStatus}>
                    {assignment.instanceStatus}
                  </Badge>
                </div>
                <p
                  className="mt-1 text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  {pending === assignment.instanceId
                    ? "Saving…"
                    : aggregateSummary(assignment)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {snapshotSummary(assignment)}
                </p>
              </div>
              {revoked ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  aria-label={`Request fresh snapshot from ${assignment.displayName}`}
                  onClick={() => void refreshSnapshot(assignment.instanceId)}
                >
                  <Camera />
                  Request fresh snapshot
                </Button>
              )}
            </div>
            {revoked ? (
              <p className="text-xs text-muted-foreground">
                This device was revoked and no longer receives profiles.
              </p>
            ) : null}
            {assignment.layers.length ? (
              <ol
                className="grid min-w-0 gap-2"
                aria-label={`Profiles for ${assignment.displayName}`}
              >
                {assignment.layers.map((layer, index) => (
                  <li
                    key={layer.profileId}
                    className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-muted/50 px-3 py-2"
                  >
                    <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">
                      {index + 1}.
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">
                        {layer.profileName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {layerSummary(layer)}
                      </p>
                      {layer.syncError ? (
                        <p className="break-words text-xs text-destructive [overflow-wrap:anywhere]">
                          {layer.syncError}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={disabled || index === 0}
                        aria-label={`Move ${layer.profileName} up for ${assignment.displayName}`}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={
                          disabled || index === assignment.layers.length - 1
                        }
                        aria-label={`Move ${layer.profileName} down for ${assignment.displayName}`}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <ConfirmButton
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={disabled}
                            aria-label={`Remove ${layer.profileName} from ${assignment.displayName}`}
                          >
                            <X />
                          </Button>
                        }
                        title={`Remove ${layer.profileName} from ${assignment.displayName}?`}
                        description={
                          assignment.layers.length > 1
                            ? "The device stops receiving this profile on its next sync. Its other profiles keep applying."
                            : "The device stops receiving this profile on its next sync and restores its own settings."
                        }
                        actionLabel="Remove profile"
                        onConfirm={() =>
                          assign(
                            assignment.instanceId,
                            ids.filter((id) => id !== layer.profileId),
                          )
                        }
                      />
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
            {assignment.warnings.length ? (
              <div className="grid gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-xs font-medium">Device notices</p>
                <ul className="grid list-disc gap-1 pl-4 text-xs">
                  {assignment.warnings.map((warning) => (
                    <li
                      key={warning}
                      className="break-words [overflow-wrap:anywhere]"
                    >
                      {warning}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {revoked ? null : (
              <Select
                value=""
                disabled={disabled || !available.length || full}
                aria-label={`Add profile to ${assignment.displayName}`}
                className="sm:max-w-xs"
                onChange={(event) => {
                  if (event.target.value)
                    void assign(assignment.instanceId, [
                      ...ids,
                      event.target.value,
                    ]);
                }}
              >
                <option value="">
                  {full
                    ? `Limit of ${maximumLayers} profiles reached`
                    : !available.length
                      ? "All profiles are assigned"
                      : assignment.layers.length
                        ? "Add another profile…"
                        : "Assign a profile…"}
                </option>
                {available.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.name}
                  </option>
                ))}
              </Select>
            )}
          </section>
        );
      })}
      {!loading && !error && !assignments.length ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No devices are enrolled yet. Enroll a device to assign profiles to it.
        </p>
      ) : null}
    </div>
  );
}

function aggregateSummary(assignment: SettingsAssignment): string {
  if (assignment.syncStatus === "unassigned") return "No profile assigned";
  const count = assignment.layers.length;
  const profiles = count === 1 ? "1 profile" : `${count} profiles`;
  if (assignment.syncStatus === "failed")
    return `${profiles} · Sync failed · ${formatTime(assignment.lastSyncAttemptAt)}`;
  if (assignment.syncStatus === "applied") return `${profiles} · Applied`;
  if (assignment.instanceStatus === "revoked")
    return `${profiles} · Not applied`;
  return assignment.instanceStatus === "online"
    ? `${profiles} · Waiting for the device to sync`
    : `${profiles} · Applies when the device connects`;
}

function layerSummary(layer: SettingsAssignmentLayer): string {
  if (layer.syncStatus === "failed")
    return `Revision ${layer.profileRevision} failed · ${formatTime(layer.lastSyncAttemptAt)}`;
  if (layer.syncStatus === "applied")
    return `Revision ${layer.profileRevision} applied · ${formatTime(layer.lastAppliedAt)}`;
  if (layer.lastAppliedRevision !== null)
    return `Revision ${layer.profileRevision} pending · Last applied ${layer.lastAppliedRevision}`;
  return `Revision ${layer.profileRevision} pending`;
}

function snapshotSummary(assignment: SettingsAssignment): string {
  const { capturedAt, refreshRequestedAt } = assignment.snapshot;
  const captured =
    capturedAt === null
      ? "No settings snapshot yet"
      : `Settings snapshot ${formatTime(capturedAt)}`;
  return refreshRequestedAt === null
    ? captured
    : `${captured} · Fresh snapshot requested`;
}
