import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import type { UserAgentLimitsSettings } from "../../../core/runtime-contract.generated.js";
import type { ShellPersistedState } from "../chat-session.model";
import { loadShellStateSnapshot } from "../lib/shell-store";
import { hasPendingMediaGeneration } from "../media/media-generation-service";
import { hasPendingChatWork, IdleShutdownMonitor } from "./shutdown-when-idle";
import { startAutomaticWorkPump } from "./automatic-work-pump";

export interface ShutdownWhenIdleOptions {
  ready: boolean;
  state: ShellPersistedState;
  settings: UserAgentLimitsSettings;
  hasUnsettledWork: () => boolean;
  flush: () => Promise<void>;
}

export const useShutdownWhenIdle = (options: ShutdownWhenIdleOptions) => {
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const monitor = useRef(new IdleShutdownMonitor());
  const activityPump = useRef<ReturnType<typeof startAutomaticWorkPump> | null>(
    null,
  );
  const busy = (): boolean =>
    !latest.current.ready ||
    latest.current.hasUnsettledWork() ||
    hasPendingChatWork(latest.current.state, latest.current.settings) ||
    hasPendingMediaGeneration();

  useEffect(() => {
    if (!isTauri()) return;
    activityPump.current = startAutomaticWorkPump(
      async () => {
        await invoke("set_window_pending_chat_work", {
          pending:
            !latest.current.ready ||
            latest.current.hasUnsettledWork() ||
            hasPendingChatWork(latest.current.state, latest.current.settings),
        });
      },
      (error) => {
        console.error("Failed to synchronize chat activity", error);
        monitor.current.setEnabled(false);
        setEnabled(false);
        void invoke("set_shutdown_when_idle", { enabled: false }).catch(
          (error: unknown) =>
            console.error("Failed to disable shutdown mode", error),
        );
      },
    );
    return () => {
      activityPump.current?.stop();
      activityPump.current = null;
    };
  }, []);

  useEffect(() => {
    activityPump.current?.wake();
  }, [options.ready, options.state, options.settings]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void invoke<boolean>("supports_idle_shutdown")
      .then(async (supported) => {
        if (disposed || !supported) return;
        setAvailable(true);
        unlisten = await listen<boolean>(
          "shutdown-when-idle-changed",
          (event) => {
            if (disposed) return;
            monitor.current.setEnabled(event.payload);
            setEnabled(event.payload);
          },
        );
        if (disposed) {
          unlisten();
          return;
        }
        const active = await invoke<boolean>("get_shutdown_when_idle");
        if (!disposed) setEnabled(active);
      })
      .catch((error: unknown) =>
        console.error("Failed to inspect shutdown support", error),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    monitor.current.setEnabled(enabled);
    if (!enabled) return;
    const pump = startAutomaticWorkPump(
      async () => {
        try {
          const finished = await monitor.current.check(
            async () => {
              if (busy()) return { busy: true, revision: 0 };
              await latest.current.flush();
              const snapshot = await loadShellStateSnapshot(
                latest.current.state,
              );
              const nativeBusy = await invoke<boolean>(
                "has_pending_shutdown_work",
              );
              return {
                busy:
                  busy() ||
                  nativeBusy ||
                  hasPendingChatWork(snapshot.state, latest.current.settings),
                revision: snapshot.revision,
              };
            },
            async (expectedRevision) => {
              if (busy()) return false;
              return invoke<boolean>("shutdown_if_idle", { expectedRevision });
            },
          );
          if (finished) setEnabled(false);
        } catch (error) {
          monitor.current.setEnabled(false);
          setEnabled(false);
          void invoke("set_shutdown_when_idle", { enabled: false }).catch(
            (error: unknown) =>
              console.error("Failed to disable shutdown mode", error),
          );
          setError(
            `Shutdown could not be checked: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      (error) => console.error("Failed to monitor shutdown", error),
    );
    return () => {
      pump.stop();
      monitor.current.setEnabled(false);
    };
  }, [enabled]);

  const toggle = async (): Promise<void> => {
    if (changing) return;
    setChanging(true);
    setError(null);
    const next = !enabled;
    if (!next) monitor.current.setEnabled(false);
    try {
      await invoke("set_shutdown_when_idle", { enabled: next });
      setEnabled(next);
    } catch (error) {
      setError(
        `Shutdown mode could not be changed: ${error instanceof Error ? error.message : String(error)}`,
      );
      monitor.current.setEnabled(enabled);
    } finally {
      setChanging(false);
    }
  };
  return { enabled, available, changing, error, toggle };
};
