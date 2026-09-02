"use client";

import type { ProductCommand, ProductSnapshot } from "@machdoch/fleet-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductRuntime } from "./product-runtime";
import { ProductShell } from "./product-shell";
import { SnapshotRefreshCoordinator } from "./snapshot-refresh-coordinator";

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
  const refreshCoordinatorRef =
    useRef<SnapshotRefreshCoordinator<ProductSnapshot> | null>(null);

  const refresh = useCallback(
    (signal?: AbortSignal): Promise<void> =>
      refreshCoordinatorRef.current?.request(signal) ?? Promise.resolve(),
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    const refreshCoordinator = new SnapshotRefreshCoordinator({
      fetchSnapshot: (signal) => runtime.getSnapshot(signal),
      onSnapshot: (nextSnapshot) => {
        if (mountedRef.current) {
          setSnapshot(nextSnapshot);
          setError(null);
        }
      },
      onError: (reason) => {
        if (mountedRef.current) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Instance is unavailable.",
          );
        }
      },
    });
    refreshCoordinatorRef.current = refreshCoordinator;
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
      refreshCoordinator.dispose();
      if (refreshCoordinatorRef.current === refreshCoordinator) {
        refreshCoordinatorRef.current = null;
      }
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh, runtime]);

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
