import { useEffect, useRef, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  enrollCloudServer,
  getFleetConnectionStatus,
  reconnectCloudServer,
  resetCloudServerConnection,
  type FleetConnectionStatus,
} from "../runtime";
import { requestFleetManagedSettingsSync } from "../chat-session/_helpers/fleet-managed-settings-sync";

const FLEET_STATUS_REFRESH_MS = 5_000;

export const RemoteAccessPanel = (): JSX.Element => {
  const [status, setStatus] = useState<FleetConnectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [managerUrl, setManagerUrl] = useState("");
  const [enrollmentKey, setEnrollmentKey] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const generation = useRef(0);
  const actionPending = useRef(false);

  useEffect(() => {
    let disposed = false;

    const refresh = async (): Promise<void> => {
      if (actionPending.current) return;
      const request = ++generation.current;
      try {
        const nextStatus = await getFleetConnectionStatus();
        if (!disposed && request === generation.current) {
          setStatus(nextStatus);
          setRefreshError(null);
        }
      } catch (refreshError) {
        if (!disposed && request === generation.current) {
          setRefreshError(
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError),
          );
        }
      }
    };

    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      FLEET_STATUS_REFRESH_MS,
    );

    return () => {
      disposed = true;
      generation.current++;
      window.clearInterval(interval);
    };
  }, []);

  const enroll = async (): Promise<void> => {
    actionPending.current = true;
    generation.current++;
    setLoading(true);
    setActionError(null);

    try {
      const nextStatus = await enrollCloudServer(
        managerUrl,
        enrollmentKey,
        instanceName,
      );
      setStatus(nextStatus);
      setEnrollmentKey("");
    } catch (enrollmentError) {
      setActionError(
        enrollmentError instanceof Error
          ? enrollmentError.message
          : String(enrollmentError),
      );
    } finally {
      actionPending.current = false;
      setLoading(false);
    }
  };

  const reconnect = async (): Promise<void> => {
    actionPending.current = true;
    generation.current++;
    setLoading(true);
    setActionError(null);
    try {
      setStatus(await reconnectCloudServer());
      requestFleetManagedSettingsSync();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      actionPending.current = false;
      setLoading(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    actionPending.current = true;
    generation.current++;
    setLoading(true);
    setActionError(null);

    try {
      setStatus(await resetCloudServerConnection());
    } catch (resetError) {
      setActionError(
        resetError instanceof Error ? resetError.message : String(resetError),
      );
    } finally {
      actionPending.current = false;
      setLoading(false);
    }
  };

  const errors = [
    actionError,
    refreshError,
    status?.lastError,
    status?.settingsSync?.lastError,
  ].filter((message): message is string => Boolean(message));
  const syncDetail = status ? settingsSyncDetail(status) : null;

  return (
    <div className="grid gap-4 px-5 py-5">
      {status?.enabled ? (
        <div className="grid gap-4 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <span className="truncate text-sm font-medium text-slate-100">
                {status.displayName}
              </span>
              <span className="truncate text-xs text-slate-500">
                {status.managerUrl}
              </span>
            </div>
            <span className="shrink-0 text-xs capitalize text-slate-400">
              {status.phase}
            </span>
          </div>
          <div className="border-t border-slate-800 pt-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-slate-500">Settings</span>
              <span className="text-slate-300">
                {settingsSyncLabel(status)}
              </span>
            </div>
            {syncDetail ? (
              <p className="mt-1 text-xs text-slate-500">{syncDetail}</p>
            ) : null}
            {status.settingsSync?.phase === "error" ? (
              <Button
                type="button"
                variant="outline"
                className="mt-3 h-8 rounded-lg border-slate-700 bg-slate-950 px-3 text-xs text-slate-200"
                onClick={() => {
                  requestFleetManagedSettingsSync();
                  setStatus((current) =>
                    current?.settingsSync
                      ? {
                          ...current,
                          settingsSync: {
                            ...current.settingsSync,
                            phase: "syncing",
                            lastAttemptAt: Math.floor(Date.now() / 1000),
                            lastError: undefined,
                          },
                        }
                      : current,
                  );
                }}
              >
                Retry sync
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            {status.phase === "error" ? (
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={() => void reconnect()}
                className="h-9 rounded-lg border-slate-700 bg-slate-950 px-3 text-xs text-slate-200"
              >
                Reconnect
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => {
                if (
                  window.confirm(
                    "Disconnect from machdoch.cloud and remove this enrollment?",
                  )
                ) {
                  void disconnect();
                }
              }}
              className="h-9 rounded-lg border-rose-500/30 bg-rose-500/10 px-3 text-xs text-rose-100 hover:bg-rose-500/15 hover:text-white"
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void enroll();
          }}
        >
          <div className="grid gap-1">
            <label
              htmlFor="cloud-url"
              className="text-xs font-medium text-slate-500"
            >
              Cloud URL
            </label>
            <Input
              id="cloud-url"
              type="url"
              value={managerUrl}
              maxLength={2048}
              onChange={(event) => setManagerUrl(event.currentTarget.value)}
              required
              className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
            />
          </div>
          <div className="grid gap-1">
            <label
              htmlFor="fleet-enrollment-key"
              className="text-xs font-medium text-slate-500"
            >
              Enrollment key
            </label>
            <Input
              id="fleet-enrollment-key"
              type="password"
              autoComplete="off"
              value={enrollmentKey}
              maxLength={54}
              onChange={(event) => setEnrollmentKey(event.currentTarget.value)}
              required
              className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
            />
          </div>
          <div className="grid gap-1">
            <label
              htmlFor="fleet-instance-name"
              className="text-xs font-medium text-slate-500"
            >
              Instance name
            </label>
            <Input
              id="fleet-instance-name"
              value={instanceName}
              maxLength={80}
              onChange={(event) => setInstanceName(event.currentTarget.value)}
              required
              className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
            />
          </div>
          <div>
            <Button
              type="submit"
              disabled={
                loading ||
                !managerUrl.trim() ||
                !enrollmentKey.trim() ||
                !instanceName.trim()
              }
              className="h-9 rounded-lg bg-sky-500 px-3 text-xs text-white hover:bg-sky-400"
            >
              Connect
            </Button>
          </div>
        </form>
      )}

      {[...new Set(errors)].map((message) => (
        <div key={message} role="alert" className="text-xs text-rose-300">
          {message}
        </div>
      ))}
    </div>
  );
};

function settingsSyncLabel(status: FleetConnectionStatus): string {
  if (!status.settingsSync) return "Checking";
  if (status.settingsSync.phase === "syncing") return "Syncing";
  if (status.settingsSync.phase === "error") return "Sync failed";
  return "Synced";
}

function settingsSyncDetail(status: FleetConnectionStatus): string | null {
  const sync = status.settingsSync;
  if (!sync) return null;
  const target = sync.profileName
    ? `${sync.profileName}${sync.revision === undefined ? "" : ` · Revision ${sync.revision}`}`
    : sync.revision === undefined
      ? null
      : `Revision ${sync.revision}`;
  const timestamp =
    sync.phase === "applied" ? sync.lastAppliedAt : sync.lastAttemptAt;
  const time = timestamp === undefined ? null : formatSyncTime(timestamp);
  return [target, time].filter(Boolean).join(" · ") || null;
}

function formatSyncTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}
