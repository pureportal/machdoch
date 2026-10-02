"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import {
  productSnapshotSchema,
  runDocumentSchema,
  runSnapshotSchema,
  type RunCommand,
  type RunSnapshot,
} from "@machdoch/fleet-protocol";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { Button } from "@/components/ui/button";
import { RunConfiguration } from "./run-configuration";
import { ServiceCard } from "./service-card";
import { AddServiceForm, type ServiceInput } from "./add-service-form";
import { ShowMore } from "@/components/show-more";

type Preview = {
  id: string;
  origin: string;
  configurationId: string;
  port: number;
  expiresAt: number;
  connections: number;
};
type StatusResponse = {
  snapshot: RunSnapshot;
  previewsEnabled: boolean;
  previews: Preview[];
};
const inputClass =
  "min-h-11 w-full min-w-0 rounded-xl border border-input bg-card px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring";
const cardClass = "min-w-0 rounded-2xl border bg-card p-5 sm:p-6";
const bytes = (value: number): string =>
  `${(value / 1024 ** 3).toFixed(1)} GiB`;

export function RunsView({
  instanceId,
  instanceName,
}: {
  instanceId: string;
  instanceName: string;
}): React.ReactElement {
  const base = `/api/instances/${encodeURIComponent(instanceId)}`;
  const [workspaces, setWorkspaces] = useState<
    Array<{ path: string; label: string }>
  >([]);
  const [workspace, setWorkspace] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceAttempt, setWorkspaceAttempt] = useState(0);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [backend, setBackend] = useState("");
  const [prefix, setPrefix] = useState("/api");
  const [stripPrefix, setStripPrefix] = useState(false);
  const busy = useRef(false);
  const active = useRef<AbortController | null>(null);
  const selection = useRef("");
  const openLogs = useRef(new Set<string>());
  const refreshVersion = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    void api<unknown>(`${base}/product/snapshot`, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const product = productSnapshotSchema.parse(payload);
        const options = (product.shell?.workspaces ?? []).map((entry) => ({
          path: entry.root,
          label: entry.label,
        }));
        setWorkspaces(options);
        const requested = new URLSearchParams(window.location.search).get(
          "workspace",
        );
        setWorkspace(
          options.find((entry) => entry.path === requested)?.path ??
            options[0]?.path ??
            "",
        );
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setWorkspaceError(
            reason instanceof Error
              ? reason.message
              : "Could not load projects.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setWorkspaceLoading(false);
      });
    return () => controller.abort();
  }, [base, workspaceAttempt]);

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<RunSnapshot | undefined> => {
      if (!workspace) return;
      const version = ++refreshVersion.current;
      const result = await api<StatusResponse>(
        `${base}/runs?workspace=${encodeURIComponent(workspace)}${openLogs.current.size ? "&logs=1" : ""}`,
        { signal },
      );
      const snapshot = runSnapshotSchema.parse(result.snapshot);
      if (
        !signal?.aborted &&
        selection.current === workspace &&
        version === refreshVersion.current
      ) {
        setData({ ...result, snapshot });
        setStatusError(null);
        return snapshot;
      }
    },
    [base, workspace],
  );

  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    selection.current = workspace;
    openLogs.current.clear();
    setData(null);
    setEditing(false);
    setError(null);
    setStatusError(null);
    setNotice(null);
    setBackend("");
    let running = false;
    const poll = async (): Promise<void> => {
      if (
        running ||
        controller.signal.aborted ||
        document.visibilityState !== "visible"
      )
        return;
      running = true;
      try {
        await refresh(controller.signal);
      } catch (reason) {
        if (!controller.signal.aborted)
          setStatusError(
            reason instanceof Error
              ? reason.message
              : "Service status is unavailable.",
          );
      } finally {
        running = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 3000);
    const visibility = (): void => {
      void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      if (active.current === controller) active.current = null;
    };
  }, [refresh, workspace]);

  const perform = async (
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> => {
    const controller = active.current;
    if (busy.current || !controller || controller.signal.aborted) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await operation(controller.signal);
      if (controller.signal.aborted) return false;
      try {
        await refresh(controller.signal);
      } catch (reason) {
        if (!controller.signal.aborted)
          setStatusError(
            reason instanceof Error
              ? reason.message
              : "Service status is unavailable.",
          );
      }
      return !controller.signal.aborted;
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Service command failed.",
        );
      return false;
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setPending(false);
    }
  };
  const execute = async (value: RunCommand): Promise<boolean> => {
    if (commandsBlocked) return false;
    return await perform(async (signal) => {
      await api(`${base}/runs?workspace=${encodeURIComponent(workspace)}`, {
        method: "POST",
        body: jsonBody(value),
        signal,
      });
    });
  };
  const save = async (
    document: unknown,
    revision: string,
  ): Promise<boolean> => {
    const parsed = runDocumentSchema.safeParse(document);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" "));
      return false;
    }
    return await execute({
      action: "save",
      commandId: crypto.randomUUID(),
      document: parsed.data,
      expectedRevision: revision,
    });
  };
  const add = async ({
    name,
    command,
    directory,
    port,
  }: ServiceInput): Promise<boolean> => {
    if (!data) return false;
    const document = structuredClone(data.snapshot.document);
    document.configurations.push({
      id: `service-${crypto.randomUUID().slice(0, 8)}`,
      name,
      kind: "task",
      primary: document.configurations.length === 0,
      command,
      workingDirectory: directory,
      environment: {},
      hotReload: true,
      ports: port ? [Number(port)] : [],
      urls: port ? [`http://127.0.0.1:${port}`] : [],
      healthCheck: port
        ? {
            kind: "tcp",
            host: "127.0.0.1",
            port: Number(port),
            restartOnFailure: false,
          }
        : null,
      restartPolicy: {
        onCrash: false,
        maxRestarts: 5,
        windowMs: 60000,
        backoffMs: 1000,
        maxBackoffMs: 30000,
      },
    });
    if (await save(document, data.snapshot.revision)) {
      setNotice("Service saved.");
      return true;
    }
    return false;
  };
  const openPreview = async (
    configurationId: string,
    targetPort: number,
  ): Promise<void> => {
    if (busy.current || commandsBlocked) return;
    const targetName = `machdoch-preview-${crypto.randomUUID()}`;
    const popup = window.open("about:blank", targetName);
    if (!popup) {
      setError("Allow pop-ups for Fleet Manager to open a private preview.");
      return;
    }
    popup.opener = null;
    const ok = await perform(async (signal) => {
      const parts = backend.split(":");
      const launch = await api<{ url: string }>(`${base}/previews`, {
        method: "POST",
        signal,
        body: jsonBody({
          target: { workspace, configurationId, port: targetPort },
          routes: backend
            ? [
                {
                  prefix,
                  configurationId: parts[0],
                  port: Number(parts[1]),
                  stripPrefix,
                },
              ]
            : [],
        }),
      });
      if (signal.aborted) return;
      const launchUrl = new URL(launch.url, window.location.origin);
      if (launchUrl.origin !== window.location.origin)
        throw new Error("Invalid preview launch URL.");
      popup.location.replace(launchUrl.href);
    });
    if (!ok) popup.close();
  };
  const commandsBlocked =
    pending ||
    workspaceLoading ||
    !data ||
    Boolean(workspaceError || statusError);
  const servicesRunning = Boolean(
    data?.snapshot.statuses.some((s) =>
      ["running", "starting", "restarting", "stopping", "unhealthy"].includes(
        s.state,
      ),
    ),
  );
  const editingBlocked = commandsBlocked || servicesRunning;
  const endpoints =
    data?.snapshot.document.configurations.flatMap((c) =>
      c.kind === "task"
        ? c.ports.map((p) => ({
            value: `${c.id}:${p}`,
            label: `${c.name} · ${p}`,
          }))
        : [],
    ) ?? [];
  const visibleError =
    workspaceError ?? statusError ?? (editing ? null : error);
  const retry = (): void => {
    if (!workspace || workspaceError)
      setWorkspaceAttempt((attempt) => attempt + 1);
    else void perform(async () => {});
  };

  return (
    <main className="fleet-services min-h-dvh p-4 sm:p-8">
      <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-5 pb-12">
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              className="inline-flex min-h-11 items-center gap-2 text-sm"
              href={`/instances/${encodeURIComponent(instanceId)}`}
            >
              <ArrowLeft size={16} /> Back to instance
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Services & previews
            </h1>
            <p className="break-all text-sm text-muted-foreground">
              {instanceName}
            </p>
          </div>
          <Button
            className="min-h-11"
            variant="outline"
            disabled={pending || workspaceLoading}
            onClick={retry}
          >
            <RefreshCw /> Refresh
          </Button>
        </header>
        {workspaces.length > 0 ? (
          <label className="grid min-w-0 gap-2 text-sm font-medium">
            Project
            <select
              className={inputClass}
              value={workspace}
              disabled={pending || editing}
              onChange={(event) => setWorkspace(event.target.value)}
            >
              {workspaces.map((option) => (
                <option key={option.path} value={option.path}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {visibleError ? (
          <div
            role="alert"
            className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-destructive p-3 text-sm"
          >
            <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {visibleError}
            </p>
            <Button
              variant="outline"
              disabled={pending || workspaceLoading}
              onClick={retry}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm">
            {notice}
          </p>
        ) : null}
        {data ? (
          <>
            <ShowMore>
              <div
                className="grid grid-cols-2 gap-3 md:grid-cols-4"
                aria-label="Host status"
              >
                {[
                  [
                    "Host CPU",
                    data.snapshot.host.cpuPercent === null
                      ? "Sampling…"
                      : `${data.snapshot.host.cpuPercent.toFixed(0)}%`,
                  ],
                  [
                    "Host memory",
                    `${bytes(data.snapshot.host.totalMemory - data.snapshot.host.freeMemory)} / ${bytes(data.snapshot.host.totalMemory)}`,
                  ],
                  [
                    "Fleet service memory",
                    bytes(data.snapshot.host.serviceMemory),
                  ],
                  [
                    "Host uptime",
                    `${Math.floor(data.snapshot.host.uptimeSeconds / 3600)}h · ${data.snapshot.host.platform}`,
                  ],
                ].map(([label, value]) => (
                  <div key={label} className={cardClass}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="mt-1 break-words font-medium">{value}</p>
                  </div>
                ))}
              </div>
            </ShowMore>
            <section className="grid gap-3" aria-label="Project services">
              {data.snapshot.document.configurations.length === 0 ? (
                <div className={cardClass}>
                  <h2 className="font-medium">No services yet</h2>
                </div>
              ) : null}
              {data.snapshot.document.configurations.map((configuration) => (
                <ServiceCard
                  key={configuration.id}
                  configuration={configuration}
                  status={data.snapshot.statuses.find(
                    (status) => status.id === configuration.id,
                  )!}
                  blocked={commandsBlocked}
                  previewsEnabled={data.previewsEnabled}
                  onExecute={execute}
                  onPreview={openPreview}
                  onLogsChange={(open) => {
                    if (open) openLogs.current.add(configuration.id);
                    else openLogs.current.delete(configuration.id);
                  }}
                />
              ))}
            </section>
            {endpoints.length > 1 ? (
              <details className={cardClass}>
                <summary className="min-h-11 cursor-pointer font-medium">
                  Connect a backend to the next preview
                </summary>
                <p className="mb-3 text-sm text-muted-foreground">
                  Route a path to another running service under the same private
                  origin. Use relative API URLs in your frontend.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm">
                    Backend service
                    <select
                      className={inputClass}
                      value={backend}
                      onChange={(e) => setBackend(e.target.value)}
                    >
                      <option value="">No extra route</option>
                      {endpoints.map((e) => (
                        <option key={e.value} value={e.value}>
                          {e.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm">
                    Path prefix
                    <input
                      className={inputClass}
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value)}
                      placeholder="/api"
                    />
                  </label>
                </div>
                <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={stripPrefix}
                    onChange={(e) => setStripPrefix(e.target.checked)}
                  />{" "}
                  Remove the prefix before forwarding
                </label>
              </details>
            ) : null}
            {data.previews.length ? (
              <section className={cardClass} aria-label="Private previews">
                <h2 className="font-medium">Private previews</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Access expires after one hour or when this login ends.
                  Stopping a service closes its connections.
                </p>
                <div className="mt-3 grid gap-3">
                  {data.previews.map((preview) => (
                    <div
                      key={preview.id}
                      className="flex min-w-0 flex-wrap items-center gap-2"
                    >
                      <p className="min-w-0 flex-1 break-all text-xs">
                        {preview.origin}
                        <br />
                        {preview.connections} connections · Expires{" "}
                        {new Date(preview.expiresAt).toLocaleTimeString()}
                      </p>
                      <Button
                        className="min-h-11"
                        variant="outline"
                        disabled={commandsBlocked}
                        onClick={() =>
                          void perform(async (signal) => {
                            await api(
                              `${base}/previews?id=${encodeURIComponent(preview.id)}`,
                              { method: "DELETE", signal },
                            );
                          })
                        }
                      >
                        Close preview
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <AddServiceForm
              key={`add-service-${workspace}`}
              pending={pending}
              blocked={editingBlocked}
              servicesRunning={servicesRunning}
              onAdd={add}
            />
            <RunConfiguration
              key={workspace}
              snapshot={data.snapshot}
              pending={pending}
              blocked={editingBlocked}
              servicesRunning={servicesRunning}
              error={error}
              onSave={save}
              onReload={async () => {
                const snapshot = await refresh(active.current?.signal);
                if (!snapshot)
                  throw new Error(
                    "Configuration could not be loaded. Try again.",
                  );
                return snapshot;
              }}
              onEditingChange={setEditing}
              onClearError={() => setError(null)}
            />
          </>
        ) : !visibleError ? (
          <p role="status" className="text-sm text-muted-foreground">
            {!workspaceLoading && !workspace
              ? "No projects."
              : "Loading services…"}
          </p>
        ) : null}
      </div>
    </main>
  );
}
