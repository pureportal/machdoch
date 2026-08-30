import {
  Copy,
  ExternalLink,
  QrCode,
  Save,
  Server,
  Square,
  Trash2,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Button } from "../../components/ui/button";
import { useOptionalRegisterCommands } from "../../commands/command-context";
import {
  asPaletteCommands,
  type CommandDefinition,
} from "../../commands/command-types";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "../../components/ui/submit-shortcut";
import {
  enrollFleetManager,
  getFleetConnectionStatus,
  resetFleetManagerConnection,
  type FleetConnectionStatus,
  type RemoteControlStatus,
} from "../../runtime";
import { cn } from "../../lib/utils";

export interface MissionControlPanelProps {
  status: RemoteControlStatus | null;
  loading: boolean;
  message: string | null;
  onEnable: () => Promise<void>;
  onDisable: () => Promise<void>;
  onOpenUrl: () => Promise<void>;
  onSavePort: (port: number) => Promise<void>;
  onForgetPairings: () => Promise<void>;
}

const DEFAULT_REMOTE_CONTROL_PORT = 43187;
const MIN_REMOTE_CONTROL_PORT = 1024;
const MAX_REMOTE_CONTROL_PORT = 65535;

const formatStatusTime = (timestamp: number | undefined): string => {
  if (!timestamp) {
    return "Not shared";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
};

const getMissionControlToken = (
  displayUrl: string | undefined,
): string | null => {
  if (!displayUrl) {
    return null;
  }

  try {
    const url = new URL(displayUrl);
    const token =
      url.searchParams.get("pair") ??
      url.searchParams.get("token") ??
      new URLSearchParams(url.hash.slice(1)).get("pair") ??
      new URLSearchParams(url.hash.slice(1)).get("token");

    return token?.trim() || null;
  } catch {
    const tokenMatch = displayUrl.match(/(?:[?#&])(?:pair|token)=([^&]+)/);
    const token = tokenMatch?.[1];

    if (!token) {
      return null;
    }

    try {
      return decodeURIComponent(token);
    } catch {
      return token;
    }
  }
};

export const MissionControlPanel = ({
  status,
  loading,
  message,
  onEnable,
  onDisable,
  onOpenUrl,
  onSavePort,
  onForgetPairings,
}: MissionControlPanelProps): JSX.Element => {
  const [linkCopyState, setLinkCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [tokenCopyState, setTokenCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const enabled = status?.enabled === true;
  const displayUrl = status?.displayUrl;
  const displayToken = getMissionControlToken(displayUrl);
  const configuredPort = status?.port ?? DEFAULT_REMOTE_CONTROL_PORT;
  const pairedDeviceCount = status?.pairedDeviceCount ?? 0;
  const [portDraft, setPortDraft] = useState(String(configuredPort));
  const [portTouched, setPortTouched] = useState(false);
  const [fleetStatus, setFleetStatus] = useState<FleetConnectionStatus | null>(
    null,
  );
  const [fleetLoading, setFleetLoading] = useState(false);
  const [fleetError, setFleetError] = useState<string | null>(null);
  const [managerUrl, setManagerUrl] = useState("");
  const [enrollmentKey, setEnrollmentKey] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const parsedPort = Number(portDraft);
  const portIsValid =
    Number.isInteger(parsedPort) &&
    parsedPort >= MIN_REMOTE_CONTROL_PORT &&
    parsedPort <= MAX_REMOTE_CONTROL_PORT;
  const portChanged = portIsValid && parsedPort !== configuredPort;

  useEffect(() => {
    if (linkCopyState === "idle") {
      return;
    }

    const timeout = window.setTimeout(() => setLinkCopyState("idle"), 1800);

    return () => window.clearTimeout(timeout);
  }, [linkCopyState]);

  useEffect(() => {
    if (tokenCopyState === "idle") {
      return;
    }

    const timeout = window.setTimeout(() => setTokenCopyState("idle"), 1800);

    return () => window.clearTimeout(timeout);
  }, [tokenCopyState]);

  useEffect(() => {
    if (!portTouched) {
      setPortDraft(String(configuredPort));
    }
  }, [configuredPort, portTouched]);

  useEffect(() => {
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const nextStatus = await getFleetConnectionStatus();
        if (!disposed) {
          setFleetStatus(nextStatus);
          setFleetError(nextStatus.lastError ?? null);
        }
      } catch (error) {
        if (!disposed) {
          setFleetError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const enroll = async (): Promise<void> => {
    setFleetLoading(true);
    setFleetError(null);
    try {
      const nextStatus = await enrollFleetManager(
        managerUrl,
        enrollmentKey,
        instanceName,
      );
      setFleetStatus(nextStatus);
      setEnrollmentKey("");
    } catch (error) {
      setFleetError(error instanceof Error ? error.message : String(error));
    } finally {
      setFleetLoading(false);
    }
  };

  const resetFleet = async (): Promise<void> => {
    setFleetLoading(true);
    setFleetError(null);
    try {
      setFleetStatus(await resetFleetManagerConnection());
    } catch (error) {
      setFleetError(error instanceof Error ? error.message : String(error));
    } finally {
      setFleetLoading(false);
    }
  };

  const copyLink = async (): Promise<void> => {
    if (!displayUrl || !navigator.clipboard) {
      setLinkCopyState("failed");
      return;
    }

    try {
      await navigator.clipboard.writeText(displayUrl);
      setLinkCopyState("copied");
    } catch {
      setLinkCopyState("failed");
    }
  };

  const copyToken = async (): Promise<void> => {
    if (!displayToken || !navigator.clipboard) {
      setTokenCopyState("failed");
      return;
    }

    try {
      await navigator.clipboard.writeText(displayToken);
      setTokenCopyState("copied");
    } catch {
      setTokenCopyState("failed");
    }
  };

  const savePort = async (): Promise<void> => {
    if (!portIsValid) {
      return;
    }

    await onSavePort(parsedPort);
    setPortTouched(false);
  };

  const missionCommandStateRef = useRef({
    enabled,
    loading,
    displayUrl,
    displayToken,
    portChanged,
    portIsValid,
    pairedDeviceCount,
    onEnable,
    onDisable,
    onOpenUrl,
    onForgetPairings,
    copyLink,
    copyToken,
    savePort,
  });
  missionCommandStateRef.current = {
    enabled,
    loading,
    displayUrl,
    displayToken,
    portChanged,
    portIsValid,
    pairedDeviceCount,
    onEnable,
    onDisable,
    onOpenUrl,
    onForgetPairings,
    copyLink,
    copyToken,
    savePort,
  };
  const missionCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = { kind: "overlay" as const, ownerId: "mission-control" };
    const state = () => missionCommandStateRef.current;
    return asPaletteCommands([
      {
        id: "mission-control.toggle",
        title: "Toggle Mission Control sharing",
        group: "Mission Control",
        scope,
        availability: () =>
          state().loading
            ? { state: "disabled", reason: "Mission Control is updating." }
            : { state: "enabled" },
        current: () => state().enabled,
        execute: () =>
          void (state().enabled ? state().onDisable() : state().onEnable()),
      },
      {
        id: "mission-control.link.copy",
        title: "Copy Mission Control link",
        group: "Mission Control",
        scope,
        availability: () =>
          state().displayUrl
            ? { state: "enabled" }
            : { state: "disabled", reason: "Mission Control is not sharing." },
        execute: () => void state().copyLink(),
      },
      {
        id: "mission-control.token.copy",
        title: "Copy Mission Control token",
        group: "Mission Control",
        scope,
        availability: () =>
          state().displayToken
            ? { state: "enabled" }
            : { state: "disabled", reason: "No pairing token is available." },
        execute: () => void state().copyToken(),
      },
      {
        id: "mission-control.open",
        title: "Open Mission Control",
        group: "Mission Control",
        scope,
        availability: () =>
          state().displayUrl
            ? { state: "enabled" }
            : { state: "disabled", reason: "Mission Control is not sharing." },
        execute: () => void state().onOpenUrl(),
      },
      {
        id: "mission-control.port.save",
        title: "Save Mission Control port",
        group: "Mission Control",
        scope,
        availability: () =>
          state().loading
            ? { state: "disabled", reason: "Mission Control is updating." }
            : !state().portIsValid
              ? { state: "disabled", reason: "Enter a valid port." }
              : state().portChanged
                ? { state: "enabled" }
                : { state: "disabled", reason: "Port is unchanged." },
        execute: () => void state().savePort(),
      },
      {
        id: "mission-control.pairings.forget",
        title: "Forget Mission Control pairings",
        group: "Mission Control",
        scope,
        availability: () =>
          state().loading || state().pairedDeviceCount === 0
            ? { state: "disabled", reason: "No pairings can be forgotten." }
            : { state: "enabled" },
        execute: () => void state().onForgetPairings(),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(missionCommands);

  return (
    <DialogContent
      data-command-owner="mission-control"
      className="app-mission-control-dialog max-h-[min(740px,calc(100vh-28px))] w-[min(900px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none"
    >
      <div className="flex max-h-[min(740px,calc(100vh-28px))] min-h-[440px] flex-col overflow-hidden">
        <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-xl font-semibold text-white">
            <Wifi className="h-5 w-5 text-sky-300" />
            Mission Control
          </DialogTitle>
          <DialogDescription className="sr-only">
            Share a secure local Mission Control link for remote session
            monitoring and commands.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-0 overflow-hidden md:grid-cols-[minmax(0,1fr)_18rem]">
          <section className="grid content-start gap-4 overflow-y-auto px-5 py-5">
            <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      enabled ? "bg-emerald-400" : "bg-slate-600",
                    )}
                  />
                  <div>
                    <div className="text-sm font-medium text-white">
                      {enabled ? "Remote sharing active" : "Remote sharing off"}
                    </div>
                    <div className="text-xs text-slate-500">
                      {formatStatusTime(status?.startedAt)}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {enabled ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={loading}
                      onClick={() => void onDisable()}
                      className="h-9 rounded-lg border-rose-500/30 bg-rose-500/10 px-3 text-xs text-rose-100 hover:bg-rose-500/15 hover:text-white"
                    >
                      <Square className="h-3.5 w-3.5" />
                      Stop
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      disabled={loading}
                      onClick={() => void onEnable()}
                      className="h-9 rounded-lg bg-sky-500 px-3 text-xs text-white hover:bg-sky-400"
                    >
                      <Wifi className="h-3.5 w-3.5" />
                      Start
                    </Button>
                  )}
                </div>
              </div>

              {displayUrl ? (
                <div className="grid gap-2">
                  <div className="grid gap-2">
                    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                      <span className="w-12 shrink-0 text-xs font-medium text-slate-500">
                        Link
                      </span>
                      <code className="min-w-0 flex-1 truncate text-xs text-slate-300">
                        {displayUrl}
                      </code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Copy Mission Control link"
                        tooltip="Copy Mission Control link"
                        onClick={() => void copyLink()}
                        className="h-8 w-8 rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Open Mission Control"
                        tooltip="Open Mission Control"
                        onClick={() => void onOpenUrl()}
                        className="h-8 w-8 rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </div>
                    {displayToken ? (
                      <div className="flex min-w-0 items-start gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                        <span className="w-12 shrink-0 pt-1 text-xs font-medium text-slate-500">
                          Token
                        </span>
                        <code className="min-w-0 flex-1 break-all pt-1 text-xs text-slate-300">
                          {displayToken}
                        </code>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Copy Mission Control token"
                          tooltip="Copy Mission Control token"
                          onClick={() => void copyToken()}
                          className="h-8 w-8 rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="text-xs text-slate-500">
                    {linkCopyState === "copied"
                      ? "Link copied"
                      : linkCopyState === "failed"
                        ? "Link copy failed"
                        : tokenCopyState === "copied"
                          ? "Token copied"
                          : tokenCopyState === "failed"
                            ? "Token copy failed"
                            : ""}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-3 border-t border-slate-800 pt-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <div className="grid gap-1">
                  <label
                    htmlFor="mission-control-port"
                    className="text-xs font-medium text-slate-500"
                  >
                    Port
                  </label>
                  <SubmitShortcut asChild>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        id="mission-control-port"
                        type="number"
                        inputMode="numeric"
                        min={MIN_REMOTE_CONTROL_PORT}
                        max={MAX_REMOTE_CONTROL_PORT}
                        value={portDraft}
                        onChange={(event) => {
                          setPortTouched(true);
                          setPortDraft(event.currentTarget.value);
                        }}
                        aria-invalid={!portIsValid}
                        className="h-9 w-32 border-slate-700 bg-slate-950 text-sm text-slate-100 [appearance:textfield] placeholder:text-slate-600 focus-visible:border-sky-500 focus-visible:ring-sky-500/30 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={loading || !portChanged}
                        onClick={() => void savePort()}
                        {...SUBMIT_SHORTCUT_ACTION_PROPS}
                        className="h-9 rounded-lg border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-800 hover:text-white"
                      >
                        <Save className="h-3.5 w-3.5" />
                        Save
                      </Button>
                    </div>
                  </SubmitShortcut>
                  {!portIsValid ? (
                    <div className="text-xs text-rose-300">
                      Use a port from {MIN_REMOTE_CONTROL_PORT} to{" "}
                      {MAX_REMOTE_CONTROL_PORT}.
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="grid gap-1">
                    <span className="text-xs font-medium text-slate-500">
                      Paired devices
                    </span>
                    <span className="text-sm text-slate-200">
                      {pairedDeviceCount}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loading || pairedDeviceCount === 0}
                    onClick={() => void onForgetPairings()}
                    className="h-9 rounded-lg border-rose-500/30 bg-rose-500/10 px-3 text-xs text-rose-100 hover:bg-rose-500/15 hover:text-white"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Forget
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <Server className="h-4 w-4 text-sky-300" />
                  Fleet Manager
                </div>
                {fleetStatus?.enabled ? (
                  <span className="text-xs capitalize text-slate-400">
                    {fleetStatus.phase}
                  </span>
                ) : null}
              </div>

              {fleetStatus?.enabled ? (
                <div className="grid gap-3">
                  <div className="grid gap-1 text-sm">
                    <span className="text-slate-100">
                      {fleetStatus.displayName}
                    </span>
                    <span className="truncate text-xs text-slate-500">
                      {fleetStatus.managerUrl}
                    </span>
                  </div>
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={fleetLoading}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Disconnect from Fleet Manager and remove this enrollment?",
                          )
                        ) {
                          void resetFleet();
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
                      onChange={(event) =>
                        setManagerUrl(event.currentTarget.value)
                      }
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
                      onChange={(event) =>
                        setInstanceName(event.currentTarget.value)
                      }
                      required
                      className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                    />
                  </div>
                  <div>
                    <Button
                      type="submit"
                      disabled={
                        fleetLoading ||
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

              {fleetError ? (
                <div className="text-xs text-rose-300">{fleetError}</div>
              ) : null}
            </div>

            <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <div className="text-sm font-medium text-white">
                Recent task streams
              </div>
              {status?.sessions.length ? (
                <div className="grid gap-2">
                  {status.sessions.slice(0, 5).map((session) => (
                    <div
                      key={session.taskId}
                      className="grid gap-1 rounded-lg border border-slate-800 bg-slate-950 p-3"
                    >
                      <div className="truncate text-sm text-slate-100">
                        {session.task}
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                        <span>{session.state}</span>
                        <span>{session.progressCount} events</span>
                        <span>{session.logs.length} logs</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-sm text-slate-500">
                  No task progress has streamed yet.
                </div>
              )}
            </div>

            {message ? (
              <div className="rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-sm text-sky-100">
                {message}
              </div>
            ) : null}
          </section>

          <aside className="grid content-start gap-4 border-t border-slate-800 bg-slate-950/80 px-5 py-5 md:border-t-0 md:border-l">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <QrCode className="h-4 w-4 text-sky-300" />
              Handoff
            </div>
            {status?.qrSvg ? (
              <div
                className="overflow-hidden rounded-lg border border-slate-800 bg-white p-3"
                dangerouslySetInnerHTML={{ __html: status.qrSvg }}
              />
            ) : (
              <div className="grid aspect-square place-items-center rounded-lg border border-dashed border-slate-800 bg-slate-900/60 text-center text-sm text-slate-500">
                Start sharing to create a QR code.
              </div>
            )}
            <div className="grid gap-1 text-xs text-slate-500">
              <div>Bind: {status?.bindAddress ?? "inactive"}</div>
              <div>LAN: {status?.lanUrl ? "available" : "not detected"}</div>
            </div>
          </aside>
        </div>
      </div>
    </DialogContent>
  );
};
