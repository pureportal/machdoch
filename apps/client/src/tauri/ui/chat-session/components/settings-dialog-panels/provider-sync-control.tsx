import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import {
  doctorProviderSync,
  getProviderSyncStatus,
  planProviderSync,
  refreshProviderSync,
  setProviderSyncEnabled,
  type ProviderSyncStatus,
} from "../../../runtime";
import { SettingsStatus } from "./shared";
import type { SettingsStatusMessage } from "./types";

export interface ProviderSyncControlProps {
  workspaceRoot: string | null;
  showDiagnostics?: boolean;
  className?: string;
}

const getProviderSyncError = (
  status: ProviderSyncStatus,
): string | undefined => {
  if (status.error) return status.error;
  const messages = status.targets
    .filter((target) => target.state === "degraded")
    .map(
      (target) =>
        target.error ??
        target.warnings.find((warning) =>
          warning.includes("OAuth authorization is required."),
        ) ??
        "Provider enrollment needs attention.",
    );
  return messages.length > 0 ? [...new Set(messages)].join(" ") : undefined;
};

export const ProviderSyncControl = ({
  workspaceRoot,
  showDiagnostics = false,
  className,
}: ProviderSyncControlProps): JSX.Element => {
  const [status, setStatus] = useState<ProviderSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<SettingsStatusMessage | null>(null);
  const [reloadSequence, setReloadSequence] = useState(0);
  const requestSequence = useRef(0);

  useEffect(() => {
    const request = ++requestSequence.current;
    setStatus(null);
    setMessage(null);
    setBusy(false);
    if (workspaceRoot?.trim())
      void getProviderSyncStatus(workspaceRoot)
        .then((nextStatus) => {
          if (request === requestSequence.current) {
            setStatus(nextStatus);
            const degradedMessage = getProviderSyncError(nextStatus);
            if (degradedMessage) {
              setMessage({ tone: "error", text: degradedMessage });
            }
          }
        })
        .catch((error: unknown) => {
          if (request === requestSequence.current) {
            setMessage({
              tone: "error",
              text: error instanceof Error ? error.message : String(error),
            });
          }
        });
    return () => {
      requestSequence.current += 1;
    };
  }, [workspaceRoot, reloadSequence]);

  const runAction = async (
    action: "enable" | "disable" | "refresh" | "plan" | "doctor",
  ): Promise<void> => {
    if (busy || !workspaceRoot?.trim()) return;
    const request = ++requestSequence.current;
    setBusy(true);
    setMessage(null);
    try {
      let nextStatus: ProviderSyncStatus;
      let nextMessage: SettingsStatusMessage;
      if (action === "refresh" || action === "enable" || action === "disable") {
        nextStatus =
          action === "refresh"
            ? await refreshProviderSync(workspaceRoot)
            : await setProviderSyncEnabled(workspaceRoot, action === "enable");
        nextMessage = {
          tone: "success",
          text:
            action === "refresh"
              ? "MCP settings synced."
              : action === "enable"
                ? "Provider MCP sync enabled."
                : "Provider MCP sync disabled and managed entries removed.",
        };
      } else if (action === "plan") {
        const plan = await planProviderSync(workspaceRoot);
        if (request !== requestSequence.current) return;
        const providers = Array.isArray(plan.providers)
          ? plan.providers.length
          : 0;
        nextMessage = {
          tone: "success",
          text: `Plan is current for ${providers} provider surface${providers === 1 ? "" : "s"}.`,
        };
        nextStatus = await getProviderSyncStatus(workspaceRoot);
      } else {
        const doctor = await doctorProviderSync(workspaceRoot);
        if (request !== requestSequence.current) return;
        nextMessage = {
          tone: doctor.healthy === true ? "success" : "error",
          text:
            doctor.healthy === true
              ? "Provider enrollment doctor reports complete coverage."
              : "Provider enrollment doctor found degraded or pending coverage.",
        };
        nextStatus = await getProviderSyncStatus(workspaceRoot);
      }
      if (request !== requestSequence.current) return;
      setStatus(nextStatus);
      const syncError = getProviderSyncError(nextStatus);
      setMessage(syncError ? { tone: "error", text: syncError } : nextMessage);
    } catch (error) {
      if (request !== requestSequence.current) return;
      let text = error instanceof Error ? error.message : String(error);
      try {
        const nextStatus = await getProviderSyncStatus(workspaceRoot);
        if (request !== requestSequence.current) return;
        setStatus(nextStatus);
      } catch (statusError) {
        if (request !== requestSequence.current) return;
        setStatus(null);
        text += ` ${statusError instanceof Error ? statusError.message : String(statusError)}`;
      }
      setMessage({
        tone: "error",
        text,
      });
    } finally {
      if (request === requestSequence.current) setBusy(false);
    }
  };

  const enabled = status?.enabled === true;
  const unavailable = !workspaceRoot?.trim();

  return (
    <div
      className={cn(
        "grid gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-sm font-semibold text-slate-100">
            Sync MCP to provider CLIs
          </p>
        </div>
        <Button
          type="button"
          role="switch"
          aria-label="Sync MCP to provider CLIs"
          aria-checked={enabled}
          disabled={busy || status === null || unavailable}
          onClick={() => {
            if (enabled) {
              void runAction("disable");
            } else {
              void runAction("enable");
            }
          }}
          className={cn(
            "h-9 min-w-24 rounded-full px-4 text-xs font-semibold",
            enabled
              ? "bg-emerald-400 text-slate-950 hover:bg-emerald-300"
              : "bg-slate-800 text-slate-200 hover:bg-slate-700",
          )}
        >
          {busy ? "Updating…" : enabled ? "Enabled" : "Disabled"}
        </Button>
      </div>

      {enabled &&
      status?.targets.some(
        (target) => target.state === "filesystem-current",
      ) ? (
        <p className="text-xs leading-5 text-slate-400">
          Existing provider runs keep their MCP settings. Start a new run to use
          changes.
        </p>
      ) : null}

      {status !== null || message?.tone !== "error" ? (
        <p className="text-xs text-slate-500">
          {unavailable
            ? "Choose a workspace before enabling provider sync."
            : status === null
              ? "Loading provider sync status…"
              : `Sync ${enabled ? "enabled" : "disabled"}${status.daemon.running ? ` · daemon ${status.daemon.pid ?? "running"}` : " · daemon stopped"}`}
        </p>
      ) : null}

      {showDiagnostics ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || unavailable || !enabled}
            onClick={() => void runAction("refresh")}
            className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || unavailable}
            onClick={() => void runAction("plan")}
            className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
          >
            Plan
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || unavailable}
            onClick={() => void runAction("doctor")}
            className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
          >
            Doctor
          </Button>
        </div>
      ) : null}

      {showDiagnostics && status?.targets.length ? (
        <div className="grid gap-1 text-xs text-slate-400 sm:grid-cols-2">
          {status.targets.map((target) => (
            <span key={`${target.provider}-${target.scope}`}>
              {target.provider} · {target.scope}:{" "}
              {target.state === "filesystem-current"
                ? "Settings synced"
                : target.state}
            </span>
          ))}
        </div>
      ) : null}
      <SettingsStatus message={message} />
      {status === null && message?.tone === "error" && !unavailable ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => setReloadSequence((sequence) => sequence + 1)}
          className="h-8 justify-self-start rounded-lg border-slate-700 bg-slate-900 px-3 text-xs"
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
};
