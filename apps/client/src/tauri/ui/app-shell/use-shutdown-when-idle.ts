import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import {
  loadShellStateRevision,
  loadShellStateSnapshot,
} from "../lib/shell-store";
import { hasPendingMediaGeneration } from "@machdoch/media-studio/tauri/ui/media/media-generation-service.js";
import {
  hasPendingLocalChatWork,
  IdleShutdownMonitor,
  PendingChatWorkInspector,
  type ShutdownWhenIdleOptions,
} from "./shutdown-when-idle";
import { startAutomaticWorkPump } from "./automatic-work-pump";

export type { ShutdownWhenIdleOptions } from "./shutdown-when-idle";

interface ShutdownMode {
  enabled: boolean;
  generation: number;
}

export const useShutdownWhenIdle = (options: ShutdownWhenIdleOptions) => {
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const changingRef = useRef(false);
  const mounted = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const mode = useRef<ShutdownMode>({ enabled: false, generation: 0 });
  const monitor = useRef(new IdleShutdownMonitor());
  const chatWorkInspector = useRef(
    new PendingChatWorkInspector(
      loadShellStateRevision,
      loadShellStateSnapshot,
    ),
  );
  const activityPump = useRef<ReturnType<typeof startAutomaticWorkPump> | null>(
    null,
  );
  const applyMode = (next: ShutdownMode): void => {
    if (!mounted.current) return;
    if (next.generation < mode.current.generation) return;
    const changed =
      next.generation !== mode.current.generation ||
      next.enabled !== mode.current.enabled;
    if (next.generation !== mode.current.generation) {
      monitor.current.setEnabled(false);
    }
    mode.current = next;
    monitor.current.setEnabled(next.enabled);
    setEnabled(next.enabled);
    if (changed && next.enabled) setError(null);
    if (changed) activityPump.current?.wake();
  };

  useEffect(() => {
    if (!isTauri()) return;
    mounted.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let currentCheck: AbortController | undefined;
    let currentTimer: ReturnType<typeof setTimeout> | undefined;

    const synchronize = async (
      signal: AbortSignal,
      arm: ShutdownMode,
    ): Promise<void> => {
      const inspected = latest.current;
      const busy = (): boolean =>
        hasPendingLocalChatWork(latest.current) ||
        hasPendingMediaGeneration() ||
        latest.current.state !== inspected.state ||
        latest.current.settings !== inspected.settings;
      const work = await chatWorkInspector.current.inspect(
        () => latest.current,
      );
      if (disposed || signal.aborted) return;
      await invoke("set_window_pending_chat_work", {
        pending:
          work.busy ||
          hasPendingLocalChatWork(latest.current) ||
          latest.current.state !== inspected.state ||
          latest.current.settings !== inspected.settings,
      });
      if (disposed || signal.aborted) return;
      if (mode.current.generation !== arm.generation) return;
      const finished = await monitor.current.check(
        async () => ({
          busy:
            work.busy ||
            busy() ||
            (await invoke<boolean>("has_pending_shutdown_work")),
          revision: work.revision,
        }),
        async (expectedRevision) => {
          if (
            disposed ||
            signal.aborted ||
            busy() ||
            mode.current.generation !== arm.generation
          )
            return false;
          return invoke<boolean>("shutdown_if_idle", {
            expectedRevision,
            expectedGeneration: arm.generation,
          });
        },
      );
      if (finished && !disposed && !signal.aborted) {
        applyMode(await invoke<ShutdownMode>("get_shutdown_when_idle"));
      }
    };

    const pump = startAutomaticWorkPump(
      async () => {
        const arm = mode.current;
        const controller = new AbortController();
        currentCheck = controller;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            synchronize(controller.signal, arm),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error("The activity check timed out. Try again."));
              }, 30_000);
              currentTimer = timer;
            }),
          ]);
        } catch (error) {
          if (disposed) return;
          console.error("Failed to check shutdown activity", error);
          if (
            mode.current.generation !== arm.generation &&
            (mode.current.enabled ||
              mode.current.generation !== arm.generation + 1)
          )
            return;
          monitor.current.setEnabled(false);
          setEnabled(false);
          setError(
            `Shutdown could not be checked: ${error instanceof Error ? error.message : String(error)}`,
          );
          try {
            const next = await invoke<ShutdownMode>("set_shutdown_when_idle", {
              enabled: false,
              expectedGeneration: arm.generation,
            });
            if (!disposed) applyMode(next);
          } catch (disarmError) {
            console.error("Failed to disable shutdown mode", disarmError);
            if (disposed || mode.current.generation !== arm.generation) return;
            setEnabled(mode.current.enabled);
            setError(
              `Shutdown mode could not be disabled: ${disarmError instanceof Error ? disarmError.message : String(disarmError)}. Try again.`,
            );
          }
        } finally {
          clearTimeout(timer);
          if (currentTimer === timer) currentTimer = undefined;
          controller.abort();
          if (currentCheck === controller) currentCheck = undefined;
        }
      },
      (error) => console.error("Failed to monitor shutdown", error),
    );
    activityPump.current = pump;

    void invoke<boolean>("supports_idle_shutdown")
      .then(async (supported) => {
        if (disposed || !supported) return;
        unlisten = await listen<ShutdownMode>(
          "shutdown-when-idle-changed",
          (event) => {
            if (!disposed) applyMode(event.payload);
          },
        );
        if (disposed) {
          unlisten();
          return;
        }
        const active = await invoke<ShutdownMode>("get_shutdown_when_idle");
        if (!disposed) {
          applyMode(active);
          setAvailable(true);
        }
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.error("Failed to inspect shutdown support", error);
        setError(
          `Shutdown mode could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return () => {
      disposed = true;
      mounted.current = false;
      currentCheck?.abort();
      clearTimeout(currentTimer);
      pump.stop();
      activityPump.current = null;
      monitor.current.setEnabled(false);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    activityPump.current?.wake();
  }, [options.ready, options.state, options.settings]);

  const toggle = async (): Promise<void> => {
    if (!available || changingRef.current) return;
    changingRef.current = true;
    setChanging(true);
    setError(null);
    const next = !mode.current.enabled;
    if (!next) monitor.current.setEnabled(false);
    try {
      applyMode(
        await invoke<ShutdownMode>("set_shutdown_when_idle", {
          enabled: next,
          expectedGeneration: mode.current.generation,
        }),
      );
    } catch (error) {
      if (!mounted.current) return;
      setError(
        `Shutdown mode could not be changed: ${error instanceof Error ? error.message : String(error)}`,
      );
      monitor.current.setEnabled(mode.current.enabled);
    } finally {
      changingRef.current = false;
      if (mounted.current) setChanging(false);
    }
  };
  return { enabled, available, changing, error, toggle };
};
