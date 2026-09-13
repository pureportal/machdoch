"use client";

import type { ProductCommand, ProductSnapshot } from "@machdoch/fleet-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProductRuntime } from "./product-runtime";
import { ProductShell } from "./product-shell";
import { SnapshotRefreshCoordinator } from "./snapshot-refresh-coordinator";
import { createComposerDraftStore } from "./use-composer-draft";

const snapshotRefreshIntervalMs = 1_500;

interface RuntimeLifecycle {
  binding: { runtime: ProductRuntime };
  controller: AbortController;
  refreshCoordinator: SnapshotRefreshCoordinator<ProductSnapshot>;
  disconnected: boolean;
}

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
  const runtimeBinding = useMemo(() => ({ runtime }), [runtime]);
  const drafts = useMemo(() => createComposerDraftStore(), [runtime]);
  const lifecycleRef = useRef<RuntimeLifecycle | null>(null);

  const refresh = useCallback((): Promise<void> => {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle || lifecycle.binding !== runtimeBinding) {
      return Promise.resolve();
    }
    return lifecycle.refreshCoordinator.request(lifecycle.controller.signal);
  }, [runtimeBinding]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setCommandError(null);
    setPendingCommands(0);
    const controller = new AbortController();
    const refreshCoordinator = new SnapshotRefreshCoordinator({
      fetchSnapshot: (signal) => runtimeBinding.runtime.getSnapshot(signal),
      onSnapshot: (nextSnapshot) => {
        if (!controller.signal.aborted) {
          setSnapshot(nextSnapshot);
          setError(null);
          lifecycle.disconnected = false;
        }
      },
      onError: (reason) => {
        if (!controller.signal.aborted) {
          lifecycle.disconnected = true;
          setError(
            reason instanceof Error
              ? reason.message
              : "Instance is unavailable.",
          );
        }
      },
    });
    const lifecycle = {
      binding: runtimeBinding,
      controller,
      refreshCoordinator,
      disconnected: false,
    };
    lifecycleRef.current = lifecycle;
    void refreshCoordinator.request(controller.signal);
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
      controller.abort();
      refreshCoordinator.dispose();
      if (lifecycleRef.current === lifecycle) {
        lifecycleRef.current = null;
      }
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [runtimeBinding]);

  const execute = useCallback(
    async (command: ProductCommand): Promise<boolean> => {
      const lifecycle = lifecycleRef.current;
      if (
        !lifecycle ||
        lifecycle.binding !== runtimeBinding ||
        lifecycle.controller.signal.aborted ||
        lifecycle.disconnected
      )
        return false;
      const { controller, refreshCoordinator } = lifecycle;
      const isCurrent = (): boolean =>
        lifecycleRef.current === lifecycle && !controller.signal.aborted;
      const request = {
        ...command,
        commandId: command.commandId ?? crypto.randomUUID(),
      } as ProductCommand;
      const foreground = command.kind !== "update-draft";
      if (foreground) {
        setPendingCommands((current) => current + 1);
        setCommandError(null);
      }
      try {
        await runtimeBinding.runtime.execute(request, controller.signal);
        if (!isCurrent()) return false;
        await refreshCoordinator.request(controller.signal);
        return isCurrent();
      } catch (reason) {
        if (isCurrent()) {
          setCommandError(
            reason instanceof Error ? reason.message : "Command failed.",
          );
        }
        return false;
      } finally {
        if (isCurrent() && foreground) {
          setPendingCommands((current) => Math.max(0, current - 1));
        }
      }
    },
    [runtimeBinding],
  );

  return (
    <ProductShell
      drafts={drafts}
      servicesHref={runtime.servicesHref}
      settingsHref={runtime.settingsHref}
      instanceName={instanceName}
      snapshot={snapshot}
      error={error}
      commandError={commandError}
      onDismissCommandError={() => setCommandError(null)}
      pendingCommands={pendingCommands}
      onCommand={execute}
      onRefresh={refresh}
    />
  );
}
