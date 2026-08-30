"use client";

import type { ProductCommand, ProductSnapshot } from "@machdoch/fleet-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductRuntime } from "./product-runtime";
import { ProductShell } from "./product-shell";

const snapshotRefreshIntervalMs = 1_500;

export function RemoteProductApp({
  instanceName,
  runtime,
}: {
  instanceName: string;
  runtime: ProductRuntime;
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingCommands, setPendingCommands] = useState(0);
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef(false);

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      try {
        const nextSnapshot = await runtime.getSnapshot(signal);
        if (!signal?.aborted && mountedRef.current) {
          setSnapshot(nextSnapshot);
          setError(null);
        }
      } catch (reason) {
        if (!signal?.aborted && mountedRef.current) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Instance is unavailable.",
          );
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [runtime],
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh(controller.signal);
      }
    }, snapshotRefreshIntervalMs);
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void refresh(controller.signal);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  const execute = useCallback(
    async (command: ProductCommand): Promise<boolean> => {
      const request = {
        ...command,
        commandId: command.commandId ?? crypto.randomUUID(),
      } as ProductCommand;
      setPendingCommands((current) => current + 1);
      setError(null);
      try {
        await runtime.execute(request);
        await refresh();
        return true;
      } catch (reason) {
        if (mountedRef.current) {
          setError(
            reason instanceof Error ? reason.message : "Command failed.",
          );
        }
        return false;
      } finally {
        if (mountedRef.current) {
          setPendingCommands((current) => Math.max(0, current - 1));
        }
      }
    },
    [refresh, runtime],
  );

  return (
    <ProductShell
      instanceName={instanceName}
      snapshot={snapshot}
      error={error}
      pendingCommands={pendingCommands}
      onCommand={execute}
      onRefresh={() => refresh()}
    />
  );
}
