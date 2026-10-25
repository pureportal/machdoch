import { useEffect, useRef, useState, type JSX } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import type { CloudWorkspaceView } from "@machdoch/fleet-protocol/cloud-workspaces";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import {
  CloudConnectionForm,
  type CloudConnectionDraft,
} from "./connection-form";
import { manageCloudWorkspaces } from "./workspace-runtime";

function connectionStatus(connection: CloudWorkspaceView): string {
  if (connection.status === "disconnected") return "Disconnected";
  if (connection.status === "disconnecting") return "Disconnect pending";
  if (connection.access === "credentials_required") return "Token required";
  if (connection.access === "ended") return "Access ended";
  if (connection.access === "unreachable") return "Cloud unavailable";
  return connection.status === "linking" ? "Link pending" : "Linked";
}

export function CloudWorkspacesPanel({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): JSX.Element {
  const [connections, setConnections] = useState<CloudWorkspaceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<CloudWorkspaceView | "new" | null>(
    null,
  );
  const [disconnecting, setDisconnecting] = useState<CloudWorkspaceView | null>(
    null,
  );
  const [draft, setDraft] = useState<CloudConnectionDraft>({
    origin: "",
    workspaceRoot,
    name: "",
    token: "",
  });
  const [disconnectToken, setDisconnectToken] = useState("");
  const generation = useRef(0);
  const alive = useRef(true);
  const returnFocus = useRef<HTMLElement | null>(null);
  const native = isTauri();

  async function refresh(remote: boolean) {
    const request = ++generation.current;
    setLoading(true);
    try {
      const next = await manageCloudWorkspaces({
        action: "list",
        refresh: remote,
      });
      if (alive.current && request === generation.current) {
        setConnections(next);
        setError("");
      }
    } catch (reason) {
      if (alive.current && request === generation.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "Workspace connections could not be loaded.",
        );
    } finally {
      if (alive.current && request === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    if (native) void refresh(true);
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [native]);
  useEffect(() => {
    if (editing === null && !busy && returnFocus.current?.isConnected) {
      returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [editing, busy]);

  function edit(connection: CloudWorkspaceView | "new", trigger: HTMLElement) {
    returnFocus.current = trigger;
    setDraft({
      origin:
        connection === "new"
          ? (connections[0]?.origin ?? "")
          : connection.origin,
      workspaceRoot:
        connection === "new" ? workspaceRoot : connection.workspaceRoot,
      name:
        connection === "new"
          ? (workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "")
          : connection.workspaceName,
      token: "",
    });
    setError("");
    setEditing(connection);
  }
  async function showActionFailure(reason: unknown) {
    if (!alive.current) return;
    const message =
      reason instanceof Error
        ? reason.message
        : "The connection action failed. Retry the action.";
    setError(message);
    try {
      const next = await manageCloudWorkspaces({
        action: "list",
        refresh: true,
      });
      if (!alive.current) return;
      setConnections(next);
      setDisconnecting((current) =>
        current
          ? (next.find((connection) => connection.id === current.id) ?? current)
          : null,
      );
    } catch {
      if (alive.current)
        setError(`${message} Connection state could not be reloaded.`);
    }
  }
  async function connect() {
    if (!editing || busy) return;
    generation.current++;
    setBusy(true);
    setLoading(false);
    setError("");
    try {
      const next = await manageCloudWorkspaces(
        editing === "new"
          ? {
              action: "connect",
              origin: draft.origin.trim(),
              token: draft.token.trim(),
              workspaceRoot: draft.workspaceRoot,
              name: draft.name.trim(),
            }
          : {
              action: "reconnect",
              id: editing.id,
              ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
            },
      );
      if (alive.current) {
        setConnections(next);
        setDraft((current) => ({ ...current, token: "" }));
        setEditing(null);
      }
    } catch (reason) {
      await showActionFailure(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function disconnect() {
    if (!disconnecting || busy) return;
    generation.current++;
    setBusy(true);
    setLoading(false);
    setError("");
    try {
      const next = await manageCloudWorkspaces({
        action: "disconnect",
        id: disconnecting.id,
        ...(disconnectToken.trim() ? { token: disconnectToken.trim() } : {}),
      });
      if (alive.current) {
        setConnections(next);
        setDisconnecting(null);
        setDisconnectToken("");
      }
    } catch (reason) {
      await showActionFailure(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const fieldClass =
    "h-9 min-w-0 border-slate-700 bg-slate-950 text-sm text-slate-100";
  const labelClass = "grid min-w-0 gap-1 text-xs text-slate-400";
  const needsToken =
    editing === "new" ||
    Boolean(
      editing &&
      (editing.status !== "linking" ||
        editing.access === "ended" ||
        editing.access === "credentials_required"),
    );
  if (!native)
    return (
      <p className="px-5 py-6 text-sm text-slate-400">
        Manage workspace connections in the Machdoch desktop app.
      </p>
    );
  return (
    <div className="grid min-w-0 gap-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || editing !== null}
          onClick={(event) => edit("new", event.currentTarget)}
        >
          Link workspace
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={
            busy || loading || editing !== null || disconnecting !== null
          }
          onClick={() => void refresh(true)}
          aria-label="Refresh workspace connections"
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {editing && (
        <CloudConnectionForm
          value={draft}
          existing={editing !== "new"}
          needsToken={needsToken}
          busy={busy}
          onChange={setDraft}
          onSubmit={() => void connect()}
          onCancel={() => {
            setDraft((current) => ({ ...current, token: "" }));
            setEditing(null);
            setError("");
          }}
          onError={setError}
        />
      )}
      {loading && connections.length === 0 ? (
        <p role="status" className="text-sm text-slate-400">
          Loading connections…
        </p>
      ) : connections.length === 0 && !editing && !error ? (
        <p className="text-sm text-slate-400">No workspaces linked.</p>
      ) : null}
      <ul className="grid min-w-0 gap-3">
        {connections.map((connection) => (
          <li
            key={connection.id}
            className="grid min-w-0 gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="grid min-w-0 gap-1">
                <h3 className="break-words text-sm font-medium text-slate-100">
                  {connection.projectName}
                </h3>
                <p className="break-words text-xs text-slate-400">
                  {connection.workspaceName} · {connection.profileName}
                </p>
                <span className="break-all text-xs text-slate-500">
                  {connection.origin}
                </span>
              </div>
              <span className="text-xs text-slate-400">
                {connectionStatus(connection)}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={
                  busy ||
                  editing !== null ||
                  connection.status === "disconnecting"
                }
                onClick={(event) => edit(connection, event.currentTarget)}
              >
                {connection.status === "disconnected"
                  ? "Reconnect"
                  : connection.status === "linking"
                    ? "Retry link"
                    : "Update token"}
              </Button>
              {connection.status !== "disconnected" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || editing !== null}
                  onClick={() => {
                    setError("");
                    setDisconnectToken("");
                    setDisconnecting(connection);
                  }}
                >
                  {connection.status === "disconnecting"
                    ? "Retry disconnect"
                    : "Disconnect"}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && !disconnecting && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}
      <Dialog
        open={disconnecting !== null}
        onOpenChange={(next) => {
          if (!next && !busy) {
            setDisconnecting(null);
            setDisconnectToken("");
            setError("");
          }
        }}
        commandOverlayId="cloud-workspace-disconnect"
      >
        <DialogContent
          className="w-[min(440px,calc(100vw-28px))] border-slate-800 bg-slate-950 text-slate-100 transition-none"
          aria-describedby="cloud-disconnect-description"
        >
          <DialogHeader>
            <DialogTitle>Disconnect workspace</DialogTitle>
          </DialogHeader>
          <p
            id="cloud-disconnect-description"
            className="text-sm text-slate-400"
          >
            This revokes the runner’s cloud access.
          </p>
          {disconnecting?.access === "credentials_required" && (
            <label className={labelClass}>
              Current runner token
              <Input
                type="password"
                value={disconnectToken}
                maxLength={200}
                autoComplete="off"
                onChange={(event) =>
                  setDisconnectToken(event.currentTarget.value)
                }
                className={fieldClass}
              />
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-rose-300">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDisconnecting(null);
                setDisconnectToken("");
                setError("");
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                (disconnecting?.access === "credentials_required" &&
                  !disconnectToken.trim())
              }
              onClick={() => void disconnect()}
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
