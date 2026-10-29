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
import {
  ManagedSettingsSection,
  ProposeToOrganization,
} from "./managed-settings-details";

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

  /** Runs a connection change; managed settings follow it right away. */
  const runAction = async (
    action: () => Promise<FleetConnectionStatus>,
  ): Promise<boolean> => {
    actionPending.current = true;
    generation.current++;
    setLoading(true);
    setActionError(null);
    try {
      setStatus(await action());
      requestFleetManagedSettingsSync();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      actionPending.current = false;
      setLoading(false);
    }
  };

  const enroll = async (): Promise<void> => {
    if (
      await runAction(() =>
        enrollCloudServer(managerUrl, enrollmentKey, instanceName),
      )
    ) {
      setEnrollmentKey("");
    }
  };

  const retrySync = (): void => {
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
  };

  const errors = [
    ...new Set(
      [actionError, refreshError, status?.lastError].filter(
        (message): message is string => Boolean(message),
      ),
    ),
  ].map((message) => (
    <p key={message} role="alert" className="break-words text-xs text-rose-300">
      {message}
    </p>
  ));

  if (status?.enabled) {
    return (
      <div className="grid gap-4 px-5 py-5">
        <section
          aria-label="Connection"
          className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <span
                title={status.displayName}
                className="truncate text-sm font-medium text-slate-100"
              >
                {status.displayName}
              </span>
              <span
                title={status.managerUrl}
                className="truncate text-xs text-slate-500"
              >
                {status.managerUrl}
              </span>
            </div>
            <span className="shrink-0 text-xs capitalize text-slate-400">
              {status.phase}
            </span>
          </div>
          {errors}
          <div className="flex flex-wrap gap-2">
            {status.phase === "error" ? (
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={() => void runAction(reconnectCloudServer)}
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
                    "Disconnect from machdoch.cloud and remove this enrollment? Settings from machdoch.cloud are removed from this device and your own versions come back.",
                  )
                ) {
                  void runAction(resetCloudServerConnection);
                }
              }}
              className="h-9 rounded-lg border-rose-500/30 bg-rose-500/10 px-3 text-xs text-rose-100 hover:bg-rose-500/15 hover:text-white"
            >
              Disconnect
            </Button>
          </div>
        </section>
        <ManagedSettingsSection
          status={status}
          formatTime={formatSyncTime}
          onRetry={retrySync}
        />
        <ProposeToOrganization status={status} />
      </div>
    );
  }

  return (
    <div className="grid gap-4 px-5 py-5">
      {status ? (
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
      ) : refreshError ? null : (
        <p role="status" className="text-xs text-slate-500">
          Checking the machdoch.cloud connection…
        </p>
      )}
      {errors}
    </div>
  );
};

function formatSyncTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}
