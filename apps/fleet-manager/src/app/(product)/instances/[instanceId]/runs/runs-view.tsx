"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCw,
  Square,
} from "lucide-react";
import {
  productSnapshotSchema,
  runDocumentSchema,
  runSnapshotSchema,
  type RunCommand,
  type RunDocument,
  type RunSnapshot,
} from "@machdoch/fleet-protocol";
import { api, jsonBody } from "@/lib/api";
import { Button } from "@/components/ui/button";

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
  "min-h-11 w-full min-w-0 rounded-md border bg-background px-3 py-2 text-base";
const cardClass = "min-w-0 rounded-xl border bg-card p-4 sm:p-5";
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
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editor, setEditor] = useState<string | null>(null);
  const [editRevision, setEditRevision] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [directory, setDirectory] = useState(".");
  const [port, setPort] = useState("");
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
    void api<unknown>(`${base}/product/snapshot`, { signal: controller.signal })
      .then((payload) => {
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
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load projects.",
          );
      });
    return () => controller.abort();
  }, [base]);

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
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
    setEditor(null);
    setError(null);
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
          setError(
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
      await refresh(controller.signal);
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
  const execute = async (value: RunCommand): Promise<boolean> =>
    await perform(async (signal) => {
      await api(`${base}/runs?workspace=${encodeURIComponent(workspace)}`, {
        method: "POST",
        body: jsonBody(value),
        signal,
      });
    });
  const save = async (
    document: RunDocument,
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
  const add = async (): Promise<void> => {
    if (!data) return;
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
      setName("");
      setCommand("");
      setPort("");
      setDirectory(".");
      setNotice("Service saved. Start it when ready.");
    }
  };
  const openPreview = async (
    configurationId: string,
    targetPort: number,
  ): Promise<void> => {
    if (busy.current) return;
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
  const editingBlocked =
    pending ||
    Boolean(
      data?.snapshot.statuses.some((s) =>
        ["running", "starting", "restarting", "stopping", "unhealthy"].includes(
          s.state,
        ),
      ),
    );
  const endpoints =
    data?.snapshot.document.configurations.flatMap((c) =>
      c.kind === "task"
        ? c.ports.map((p) => ({
            value: `${c.id}:${p}`,
            label: `${c.name} · ${p}`,
          }))
        : [],
    ) ?? [];

  return (
    <main className="h-dvh overflow-y-auto p-3 sm:p-6">
      <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-5 pb-12">
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              className="inline-flex min-h-11 items-center gap-2 text-sm"
              href={`/instances/${encodeURIComponent(instanceId)}`}
            >
              <ArrowLeft size={16} /> Back to projects
            </Link>
            <h1 className="text-2xl font-semibold">Services & previews</h1>
            <p className="break-all text-sm text-muted-foreground">
              {instanceName}
            </p>
          </div>
          <Button
            className="min-h-11"
            variant="outline"
            disabled={pending || !workspace}
            onClick={() =>
              void perform(async (signal) => {
                await refresh(signal);
              })
            }
          >
            <RefreshCw /> Refresh
          </Button>
        </header>
        <label className="grid min-w-0 gap-2 text-sm font-medium">
          Project
          <select
            className={inputClass}
            value={workspace}
            disabled={pending || editor !== null}
            onChange={(event) => setWorkspace(event.target.value)}
          >
            {workspaces.map((option) => (
              <option key={option.path} value={option.path}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {error ? (
          <div
            role="alert"
            className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-destructive p-3 text-sm"
          >
            <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</p>
            <Button variant="outline" onClick={() => setError(null)}>
              Dismiss
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
            {!data.previewsEnabled ? (
              <p className="rounded-lg border p-3 text-sm">
                Private previews need a wildcard HTTPS domain. Configure{" "}
                <code>previews.baseUrl</code> on Fleet Manager; service controls
                already work.
              </p>
            ) : null}
            <section className="grid gap-3" aria-label="Project services">
              {data.snapshot.document.configurations.length === 0 ? (
                <div className={cardClass}>
                  <h2 className="font-medium">Run your project here</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Add a development server, backend, landing page, or worker
                    below. Your agent can also write .machdoch/run.json. Nothing
                    starts automatically.
                  </p>
                </div>
              ) : null}
              {data.snapshot.document.configurations.map((config) => {
                const status = data.snapshot.statuses.find(
                  (s) => s.id === config.id,
                )!;
                const running = [
                  "running",
                  "unhealthy",
                  "starting",
                  "restarting",
                  "stopping",
                ].includes(status.state);
                return (
                  <article key={config.id} className={cardClass}>
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="break-words font-semibold">
                          {config.name}
                        </h2>
                        <p className="mt-1 text-sm capitalize">
                          {status.state === "stopped" && status.exitCode === 0
                            ? "Completed"
                            : status.state}
                          {status.health ? ` · ${status.health}` : ""}
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {config.kind === "task"
                            ? config.command
                            : `${config.startOrder} group · ${config.children.length} services`}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          className="min-h-11"
                          variant="outline"
                          disabled={pending || running}
                          onClick={() =>
                            void execute({
                              action: "start",
                              commandId: crypto.randomUUID(),
                              configurationId: config.id,
                            })
                          }
                        >
                          <Play /> Start
                        </Button>
                        <Button
                          className="min-h-11"
                          variant="outline"
                          disabled={pending || !running}
                          onClick={() =>
                            void execute({
                              action: "stop",
                              commandId: crypto.randomUUID(),
                              configurationId: config.id,
                            })
                          }
                        >
                          <Square /> Stop
                        </Button>
                        <Button
                          className="min-h-11"
                          variant="outline"
                          disabled={pending || status.state === "stopping"}
                          onClick={() =>
                            void execute({
                              action: "restart",
                              commandId: crypto.randomUUID(),
                              configurationId: config.id,
                            })
                          }
                        >
                          <RotateCw /> Restart
                        </Button>
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {status.pid ? `PID ${status.pid} · ` : ""}
                      {status.restartCount} automatic restarts
                      {status.startedAt
                        ? ` · Started ${new Date(status.startedAt).toLocaleTimeString()}`
                        : ""}
                      {status.exitCode !== null
                        ? ` · Exit ${status.exitCode}`
                        : ""}
                    </p>
                    {config.kind === "task" && config.ports.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {config.ports.map((p) => (
                          <Button
                            key={p}
                            className="min-h-11"
                            disabled={
                              pending ||
                              !status.pid ||
                              !data.previewsEnabled ||
                              !["running", "unhealthy"].includes(status.state)
                            }
                            onClick={() => void openPreview(config.id, p)}
                          >
                            <ExternalLink /> Preview :{p}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                    {config.kind === "task" ? (
                      <details
                        className="mt-3"
                        onToggle={(event) => {
                          if (event.currentTarget.open)
                            openLogs.current.add(config.id);
                          else openLogs.current.delete(config.id);
                        }}
                      >
                        <summary className="flex min-h-11 cursor-pointer items-center text-sm">
                          Logs
                        </summary>
                        <pre
                          tabIndex={0}
                          aria-label={`${config.name} logs`}
                          className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
                        >
                          {status.logs.length
                            ? status.logs
                                .map(
                                  (line) =>
                                    `${new Date(line.at).toLocaleTimeString()} ${line.stream}  ${line.line}`,
                                )
                                .join("\n")
                            : "No output yet."}
                        </pre>
                      </details>
                    ) : null}
                  </article>
                );
              })}
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
                        disabled={pending}
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
            <details className={cardClass}>
              <summary className="min-h-11 cursor-pointer font-medium">
                Add service
              </summary>
              <form
                className="mt-3 grid gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void add();
                }}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm">
                    Name
                    <input
                      required
                      maxLength={120}
                      className={inputClass}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Frontend"
                    />
                  </label>
                  <label className="grid gap-1 text-sm">
                    Working directory
                    <input
                      required
                      className={inputClass}
                      value={directory}
                      onChange={(e) => setDirectory(e.target.value)}
                      placeholder="."
                    />
                  </label>
                </div>
                <label className="grid gap-1 text-sm">
                  Command
                  <input
                    required
                    maxLength={8000}
                    className={inputClass}
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="pnpm run dev --host 127.0.0.1"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  HTTP port (optional for workers and one-off commands)
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    className={inputClass}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="3000"
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Bind servers to loopback. Install project dependencies before
                  starting. Commands run as the Fleet service account.
                </p>
                <Button
                  className="min-h-11 justify-self-start"
                  disabled={editingBlocked}
                  type="submit"
                >
                  Save service
                </Button>
                {editingBlocked && !pending ? (
                  <p className="text-sm">
                    Stop project services to change their configuration.
                  </p>
                ) : null}
              </form>
            </details>
            <section className={cardClass}>
              <h2 className="font-medium">Run configuration</h2>
              <p className="my-2 text-sm text-muted-foreground">
                Edit commands, environment, health checks, restart policies, and
                parallel or sequential groups. Stored environment values are
                redacted and preserved when unchanged.
              </p>
              {editor === null ? (
                <Button
                  className="min-h-11"
                  variant="outline"
                  disabled={editingBlocked}
                  onClick={() => {
                    setEditor(JSON.stringify(data.snapshot.document, null, 2));
                    setEditRevision(data.snapshot.revision);
                  }}
                >
                  Edit run.json
                </Button>
              ) : (
                <form
                  className="grid gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    let parsed: RunDocument;
                    try {
                      parsed = runDocumentSchema.parse(JSON.parse(editor));
                    } catch (reason) {
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : "Invalid run configuration.",
                      );
                      return;
                    }
                    void save(parsed, editRevision).then((ok) => {
                      if (ok) setEditor(null);
                    });
                  }}
                >
                  <label className="grid gap-2 text-sm">
                    run.json
                    <textarea
                      className={`${inputClass} min-h-80 font-mono text-sm`}
                      spellCheck={false}
                      value={editor}
                      onChange={(e) => setEditor(e.target.value)}
                    />
                  </label>
                  <div className="flex gap-2">
                    <Button
                      className="min-h-11"
                      disabled={editingBlocked}
                      type="submit"
                    >
                      Save configuration
                    </Button>
                    <Button
                      className="min-h-11"
                      variant="outline"
                      disabled={pending}
                      onClick={() => setEditor(null)}
                      type="button"
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </section>
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {error ? "Service status unavailable." : "Loading services…"}
          </p>
        )}
      </div>
    </main>
  );
}
