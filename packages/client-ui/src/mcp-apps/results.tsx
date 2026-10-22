import { useEffect, useRef, useState, type JSX } from "react";
import type { McpAppView } from "@machdoch/fleet-protocol/mcp-apps";
import type { TaskThinkingTrace } from "@machdoch/fleet-protocol/task-thinking";
import { connectMcpApp, type McpAppInvoke } from "./host";
import { sandboxProxyUrl } from "./sandbox";

function McpAppResult({
  id,
  workspaceRoot,
  invoke,
}: {
  id: string;
  workspaceRoot: string;
  invoke: McpAppInvoke;
}): JSX.Element | null {
  const [view, setView] = useState<McpAppView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [height, setHeight] = useState(360);
  const [attempt, setAttempt] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const currentInvoke = useRef(invoke);
  currentInvoke.current = invoke;
  useEffect(() => {
    let active = true;
    let version = 0;
    let loaded = false;
    setError(null);
    const load = async (): Promise<void> => {
      const request = ++version;
      try {
        const settings = await currentInvoke.current<{ enabled: boolean }>(
          workspaceRoot,
          { action: "settings" },
        );
        if (!active || request !== version) return;
        setDisabled(!settings.enabled);
        if (!settings.enabled) {
          loaded = false;
          setView(null);
          setError(null);
          return;
        }
        if (loaded) return;
        const result = await currentInvoke.current<McpAppView>(workspaceRoot, {
          action: "load",
          id,
        });
        if (active && request === version) {
          loaded = true;
          setView(result);
          setError(null);
        }
      } catch (cause) {
        if (active && request === version) {
          loaded = false;
          setView(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    void load();
    const refresh = (): void => {
      void load();
    };
    window.addEventListener("machdoch:mcp-apps", refresh);
    window.addEventListener("focus", refresh);
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("machdoch:mcp-apps");
    if (channel) channel.onmessage = refresh;
    return () => {
      active = false;
      window.removeEventListener("machdoch:mcp-apps", refresh);
      window.removeEventListener("focus", refresh);
      channel?.close();
    };
  }, [id, workspaceRoot, attempt]);
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (!view || !target || disabled) return;
    setInitialized(false);
    const timeout = window.setTimeout(() => {
      host.close();
      setError("The interactive result did not start. Retry to load it again.");
      setView(null);
    }, 20_000);
    const host = connectMcpApp({
      view,
      workspaceRoot,
      invoke: (root, input) => currentInvoke.current(root, input),
      send: (message) => target.postMessage(message, "*"),
      confirmTool: async (name, args) =>
        window.confirm(`Run ${name}?\n\n${JSON.stringify(args, null, 2)}`),
      onHeight: setHeight,
      onInitialized: () => {
        window.clearTimeout(timeout);
        setInitialized(true);
      },
    });
    const receive = (event: MessageEvent): void => {
      if (event.source === target && event.origin === "null")
        void host.receive(event.data);
    };
    window.addEventListener("message", receive);
    frame.current!.src = sandboxProxyUrl(view.csp);
    return () => {
      window.clearTimeout(timeout);
      host.close();
      window.removeEventListener("message", receive);
    };
  }, [view, workspaceRoot, disabled]);
  if (disabled) return null;
  return (
    <section
      className="w-full overflow-hidden rounded-lg border border-slate-700"
      aria-label={view?.title ?? "Interactive result"}
    >
      {error ? (
        <div className="space-y-2 p-3 text-sm">
          <p role="alert" className="text-rose-300">
            {error}
          </p>
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-slate-500/15"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      ) : view ? (
        <>
          {!initialized && (
            <p role="status" className="p-3 text-sm">
              Loading interactive result…
            </p>
          )}
          <iframe
            ref={frame}
            title={view.title}
            sandbox="allow-scripts allow-same-origin"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'"
            referrerPolicy="no-referrer"
            className="w-full border-0"
            style={{ height }}
          />
        </>
      ) : (
        <p role="status" className="p-3 text-sm">
          Loading interactive result…
        </p>
      )}
    </section>
  );
}

export function McpAppResults({
  thinking,
  appIds = [],
  workspaceRoot,
  invoke,
}: {
  thinking?: TaskThinkingTrace | undefined;
  appIds?: string[] | undefined;
  workspaceRoot: string | null | undefined;
  invoke: McpAppInvoke;
}): JSX.Element | null {
  const ids = [
    ...new Set([
      ...appIds,
      ...(thinking?.timelineEvents.flatMap((event) =>
        typeof event.metadata?.mcpAppId === "string"
          ? [event.metadata.mcpAppId]
          : [],
      ) ?? []),
    ]),
  ].filter((id) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id));
  if (!workspaceRoot || !ids.length) return null;
  return (
    <div className="grid w-full gap-3">
      {ids.map((id) => (
        <McpAppResult
          key={`${workspaceRoot}:${id}`}
          id={id}
          workspaceRoot={workspaceRoot}
          invoke={invoke}
        />
      ))}
    </div>
  );
}
