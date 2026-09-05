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
  const [commandError, setCommandError] = useState<string | null>(null);
  const [pendingCommands, setPendingCommands] = useState(0);
  const mountedRef = useRef(true);
  const runtimeControllerRef = useRef<AbortController | null>(null);
  const refreshCoordinatorRef =
    useRef<SnapshotRefreshCoordinator<ProductSnapshot> | null>(null);

  const refresh = useCallback(
    (signal?: AbortSignal): Promise<void> =>
      refreshCoordinatorRef.current?.request(signal) ?? Promise.resolve(),
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    setSnapshot(null);
    setError(null);
    setCommandError(null);
    setPendingCommands(0);
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
    runtimeControllerRef.current = controller;
    void refresh(controller.signal);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshCoordinator.poll(controller.signal);
      }
    }, snapshotRefreshIntervalMs);
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        void refreshCoordinator.poll(controller.signal);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      controller.abort();
      if (runtimeControllerRef.current === controller)
        runtimeControllerRef.current = null;
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
      const controller = runtimeControllerRef.current;
      if (!controller || controller.signal.aborted) return false;
      const isCurrent = (): boolean =>
        runtimeControllerRef.current === controller &&
        !controller.signal.aborted;
      const request = {
        ...command,
        commandId: command.commandId ?? crypto.randomUUID(),
      } as ProductCommand;
      setPendingCommands((current) => current + 1);
      setCommandError(null);
      try {
        await runtime.execute(request, controller.signal);
        if (!isCurrent()) return false;
        await refresh();
        return isCurrent();
      } catch (reason) {
        if (isCurrent()) {
          setCommandError(
            reason instanceof Error ? reason.message : "Command failed.",
          );
        }
        return false;
      } finally {
        if (isCurrent()) {
          setPendingCommands((current) => Math.max(0, current - 1));
        }
      }
    },
    [refresh, runtime],
  );

  return (
    <ProductShell
      servicesHref={runtime.servicesHref}
      instanceName={instanceName}
      snapshot={snapshot}
      error={error}
      commandError={commandError}
      onDismissCommandError={() => setCommandError(null)}
      pendingCommands={pendingCommands}
      onCommand={execute}
      onRefresh={() => refresh()}
    />
  );
}
