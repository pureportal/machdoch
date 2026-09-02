import { Server } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { Button } from "../../components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import {
  enrollFleetManager,
  getFleetConnectionStatus,
  resetFleetManagerConnection,
  type FleetConnectionStatus,
} from "../../runtime";
import { requestFleetManagedSettingsSync } from "../_helpers/fleet-managed-settings-sync";

const FLEET_STATUS_REFRESH_MS = 5_000;

export const FleetManagerPanel = (): JSX.Element => {
  const [status, setStatus] = useState<FleetConnectionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [managerUrl, setManagerUrl] = useState("");
  const [enrollmentKey, setEnrollmentKey] = useState("");
  const [instanceName, setInstanceName] = useState("");

  useEffect(() => {
    let disposed = false;

    const refresh = async (): Promise<void> => {
      try {
        const nextStatus = await getFleetConnectionStatus();
        if (!disposed) {
          setStatus(nextStatus);
          setRefreshError(null);
        }
      } catch (refreshError) {
        if (!disposed) {
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
      window.clearInterval(interval);
    };
  }, []);

  const enroll = async (): Promise<void> => {
    setLoading(true);
    setActionError(null);

    try {
      const nextStatus = await enrollFleetManager(
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
      setLoading(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setLoading(true);
    setActionError(null);

    try {
      setStatus(await resetFleetManagerConnection());
    } catch (resetError) {
      setActionError(
        resetError instanceof Error ? resetError.message : String(resetError),
      );
    } finally {
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
    <DialogContent className="app-fleet-manager-dialog w-[min(560px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none">
      <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
        <DialogTitle className="flex items-center gap-2 text-xl font-semibold text-white">
          <Server className="h-5 w-5 text-sky-300" />
          Fleet Manager
        </DialogTitle>
        <DialogDescription className="sr-only">
          Configure the Fleet Manager connection.
        </DialogDescription>
      </DialogHeader>

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
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                onClick={() => {
                  if (
                    window.confirm(
                      "Disconnect from Fleet Manager and remove this enrollment?",
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
                htmlFor="fleet-manager-url"
                className="text-xs font-medium text-slate-500"
              >
                Manager URL
              </label>
              <Input
                id="fleet-manager-url"
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
                onChange={(event) =>
                  setEnrollmentKey(event.currentTarget.value)
                }
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
    </DialogContent>
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
