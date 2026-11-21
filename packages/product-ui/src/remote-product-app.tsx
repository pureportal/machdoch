"use client";

import type { ProductCommand, ProductSnapshot } from "@machdoch/fleet-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { RemoteComposerProps } from "./remote-composer-props";
import type { RemoteConversationProps } from "./conversation";
import type { ProductRuntime } from "./product-runtime";
import { ProductShell } from "./product-shell";
import type { SessionHeaderAccessoryProps } from "./session-header";
import type { ProductView } from "./product-rail";
import { SnapshotRefreshCoordinator } from "./snapshot-refresh-coordinator";
import { shareStructure } from "./share-structure";
import {
  activateCachedSession,
  optimisticUpdate,
  type CachedSessionView,
  type OptimisticUpdate,
} from "./optimistic-commands";
import { createComposerDraftStore } from "./use-composer-draft";
import type { SessionDataSource } from "./session-data";
import type { SessionSidebarCommandState } from "./session-sidebar-commands-state";

const snapshotRefreshIntervalMs = 1_500;
const activeSnapshotRefreshIntervalMs = 750;
const cachedSessionLimit = 20;

interface RuntimeLifecycle {
  binding: { runtime: ProductRuntime };
  controller: AbortController;
  refreshCoordinator: SnapshotRefreshCoordinator<ProductSnapshot>;
  disconnected: boolean;
  commandTail: Promise<void> | null;
}

export function RemoteProductApp({
  Composer,
  Conversation,
  SidebarCommands,
  SessionHeaderAccessory,
  initialView,
  instanceName,
  runtime,
  sessionData,
}: {
  Composer: ComponentType<RemoteComposerProps>;
  Conversation: ComponentType<RemoteConversationProps>;
  SidebarCommands?: ComponentType<SessionSidebarCommandState> | undefined;
  SessionHeaderAccessory?:
    | ComponentType<SessionHeaderAccessoryProps>
    | undefined;
  initialView?: ProductView;
  instanceName: string;
  runtime: ProductRuntime;
  sessionData?: SessionDataSource | undefined;
}): React.ReactElement {
  const [snapshot, setSnapshot] = useState<ProductSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [pendingCommands, setPendingCommands] = useState(0);
  const [optimistic, setOptimistic] = useState<
    Array<{ commandId: string; update: OptimisticUpdate }>
  >([]);
  const displayedSnapshot = useMemo(
    () =>
      snapshot &&
      optimistic.reduce((current, entry) => entry.update(current), snapshot),
    [snapshot, optimistic],
  );
  const runtimeBinding = useMemo(() => ({ runtime }), [runtime]);
  const drafts = useMemo(() => createComposerDraftStore(), [runtime]);
  const lifecycleRef = useRef<RuntimeLifecycle | null>(null);
  const sessionViews = useRef(new Map<string, CachedSessionView>());

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
    setOptimistic([]);
    sessionViews.current.clear();
    const controller = new AbortController();
    let replying = false;
    let pollTimer: number | undefined;
    const refreshCoordinator = new SnapshotRefreshCoordinator({
      fetchSnapshot: (signal) => runtimeBinding.runtime.getSnapshot(signal),
      onSnapshot: (nextSnapshot) => {
        if (!controller.signal.aborted) {
          const shell = nextSnapshot.shell;
          const wasReplying = replying;
          replying = shell?.composer?.isExecuting === true;
          if (replying && !wasReplying) {
            window.clearTimeout(pollTimer);
            schedulePoll();
          }
          if (shell?.activeSessionId) {
            const views = sessionViews.current;
            views.delete(shell.activeSessionId);
            views.set(shell.activeSessionId, {
              visibleMessages: shell.visibleMessages,
              composer:
                shell.composer?.sessionId === shell.activeSessionId
                  ? shell.composer
                  : undefined,
            });
            if (views.size > cachedSessionLimit)
              views.delete(views.keys().next().value!);
          }
          setSnapshot((previous) => {
            const shared = shareStructure(previous, nextSnapshot);
            return previous &&
              shareStructure(previous, {
                ...shared,
                serverTime: previous.serverTime,
              }) === previous
              ? previous
              : shared;
          });
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
      commandTail: null,
    };
    lifecycleRef.current = lifecycle;
    void refreshCoordinator.request(controller.signal);
    const schedulePoll = (): void => {
      pollTimer = window.setTimeout(
        () => {
          if (document.visibilityState === "visible") {
            void refreshCoordinator.poll(controller.signal);
          }
          schedulePoll();
        },
        replying ? activeSnapshotRefreshIntervalMs : snapshotRefreshIntervalMs,
      );
    };
    schedulePoll();
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === "visible") {
        void refreshCoordinator.poll(controller.signal);
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    return () => {
      controller.abort();
      refreshCoordinator.dispose();
      if (lifecycleRef.current === lifecycle) {
        lifecycleRef.current = null;
      }
      window.clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
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
      const commandId = command.commandId ?? crypto.randomUUID();
      const request = { ...command, commandId } as ProductCommand;
      const cachedView =
        command.kind === "activate-session"
          ? sessionViews.current.get(command.sessionId)
          : undefined;
      const update =
        command.kind === "activate-session" && cachedView
          ? activateCachedSession(command.sessionId, cachedView)
          : optimisticUpdate(request);
      const background = command.kind === "update-draft";
      const blocking =
        !background && (!update || command.kind === "submit-message");
      if (update)
        setOptimistic((current) => [
          ...current,
          { commandId, update },
        ]);
      if (!background) setCommandError(null);
      if (blocking) setPendingCommands((current) => current + 1);
      try {
        if (background) {
          await runtimeBinding.runtime.execute(request, controller.signal);
        } else {
          const send = () =>
            runtimeBinding.runtime.execute(request, controller.signal);
          const previous = lifecycle.commandTail;
          const sent = previous ? previous.then(send) : send();
          const tail = sent.then(
            () => undefined,
            () => undefined,
          );
          lifecycle.commandTail = tail;
          void tail.then(() => {
            if (lifecycle.commandTail === tail) lifecycle.commandTail = null;
          });
          await sent;
        }
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
        if (isCurrent() && update)
          setOptimistic((current) =>
            current.filter((entry) => entry.commandId !== commandId),
          );
        if (isCurrent() && blocking) {
          setPendingCommands((current) => Math.max(0, current - 1));
        }
      }
    },
    [runtimeBinding],
  );

  return (
    <ProductShell
      Composer={Composer}
      Conversation={Conversation}
      SidebarCommands={SidebarCommands}
      SessionHeaderAccessory={SessionHeaderAccessory}
      {...(initialView ? { initialView } : {})}
      drafts={drafts}
      mediaHref={runtime.mediaHref}
      speechHref={runtime.speechHref}
      workspaceHref={runtime.workspaceHref}
      ralphHref={runtime.ralphHref}
      schedulerHref={runtime.schedulerHref}
      instructionsHref={runtime.instructionsHref}
      mcpHref={runtime.mcpHref}
      servicesHref={runtime.servicesHref}
      settingsHref={runtime.settingsHref}
      instanceName={instanceName}
      snapshot={displayedSnapshot}
      error={error}
      commandError={commandError}
      onDismissCommandError={() => setCommandError(null)}
      pendingCommands={pendingCommands}
      onCommand={execute}
      onRefresh={refresh}
      sessionData={sessionData}
    />
  );
}
