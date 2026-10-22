import { useEffect, useRef, useState, type JSX } from "react";
import type { McpAppInvoke } from "./host";

export function McpAppsSettings({
  invoke,
}: {
  invoke: McpAppInvoke;
}): JSX.Element {
  const run = useRef(invoke);
  run.current = invoke;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void run
      .current<{ enabled: boolean }>("", { action: "settings" })
      .then((value) => {
        if (active) setEnabled(value.enabled);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={busy || enabled === null}
          onChange={(event) => {
            const value = event.target.checked;
            const previous = enabled;
            setEnabled(value);
            setBusy(true);
            setError(null);
            void run
              .current<{ enabled: boolean }>("", {
                action: "set-enabled",
                enabled: value,
              })
              .then((settings) => {
                setEnabled(settings.enabled);
                window.dispatchEvent(new Event("machdoch:mcp-apps"));
                if (typeof BroadcastChannel !== "undefined") {
                  const channel = new BroadcastChannel("machdoch:mcp-apps");
                  channel.postMessage(settings);
                  channel.close();
                }
              })
              .catch((cause: unknown) => {
                setEnabled(previous);
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              })
              .finally(() => setBusy(false));
          }}
        />
        MCP Apps
      </label>
      {error && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
