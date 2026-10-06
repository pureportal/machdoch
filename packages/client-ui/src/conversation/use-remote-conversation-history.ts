import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProductMessage } from "@machdoch/fleet-protocol";
import {
  sessionMessagePageSchema,
  type SessionMessagePage,
} from "@machdoch/fleet-protocol/session-data";
import type { FleetOperationTransport } from "@machdoch/product-ui";
import type { TaskExecutionTimeoutState } from "@machdoch/fleet-protocol/task-thinking";

async function readMessagePage(
  transport: FleetOperationTransport,
  sessionId: string,
  previous?: SessionMessagePage | null,
): Promise<SessionMessagePage> {
  const response = sessionMessagePageSchema.safeParse(
    await transport.invoke("get_session_message_page", {
      sessionId,
      limit: 80,
      ...(previous
        ? {
            beforeMessageId: previous.messages[0]?.id,
            expectedRevision: previous.revision,
          }
        : {}),
    }),
  );
  if (!response.success)
    throw new Error("Could not load the conversation. Reload its history.");
  const page = response.data;
  if (
    page.sessionId !== sessionId ||
    (previous && page.revision !== previous.revision)
  )
    throw new Error("The conversation changed. Reload its history.");
  const identifiers = new Set(page.messages.map(({ id }) => id));
  if (
    identifiers.size !== page.messages.length ||
    (page.hasEarlier && page.messages.length === 0) ||
    previous?.messages.some(({ id }) => identifiers.has(id))
  )
    throw new Error("Could not load the conversation. Reload its history.");
  return page;
}

export function useRemoteConversationHistory({
  sessionId,
  messages,
  running,
  enabled,
  transport,
}: {
  sessionId: string;
  messages: ProductMessage[];
  running: boolean;
  enabled: boolean;
  transport: FleetOperationTransport;
}) {
  const generation = useRef(0);
  const inflight = useRef<number | null>(null);
  const queuedRefresh = useRef(false);
  const acknowledgedTimeouts = useRef(
    new Map<string, TaskExecutionTimeoutState>(),
  );
  const latest = useRef({ sessionId, transport, running, enabled });
  latest.current = { sessionId, transport, running, enabled };
  const currentPage = useRef<SessionMessagePage | null>(null);
  const [page, setPage] = useState<SessionMessagePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshotIdentity = JSON.stringify(messages);
  const observedSnapshot = useRef({ running, snapshotIdentity });
  const load = useCallback(async (earlier = false): Promise<void> => {
    const current = latest.current;
    if (!current.enabled || (earlier && inflight.current !== null)) return;
    if (inflight.current !== null) {
      queuedRefresh.current = true;
      return;
    }
    const previous = earlier ? currentPage.current : null;
    if (earlier && !previous?.hasEarlier) return;
    const attempt = ++generation.current;
    inflight.current = attempt;
    setLoading(true);
    setError(null);
    try {
      let next = await readMessagePage(
        current.transport,
        current.sessionId,
        previous,
      );
      if (attempt !== generation.current) return;
      if (!earlier) {
        const target = currentPage.current?.messages.length ?? 0;
        while (next.hasEarlier && next.messages.length < target) {
          const older = await readMessagePage(
            current.transport,
            current.sessionId,
            next,
          );
          if (attempt !== generation.current) return;
          next = { ...older, messages: [...older.messages, ...next.messages] };
        }
      }
      const combined = previous
        ? { ...next, messages: [...next.messages, ...previous.messages] }
        : next;
      combined.messages = combined.messages.map((message) => {
        const acknowledged = acknowledgedTimeouts.current.get(message.id);
        if (!acknowledged) return message;
        const thinking = message.thinking;
        if (
          thinking?.status !== "running" ||
          (thinking.timeout &&
            (thinking.timeout.lastActivityAt > acknowledged.lastActivityAt ||
              (thinking.timeout.lastActivityAt ===
                acknowledged.lastActivityAt &&
                thinking.timeout.idleTimeoutMs === acknowledged.idleTimeoutMs)))
        ) {
          acknowledgedTimeouts.current.delete(message.id);
          return message;
        }
        return {
          ...message,
          thinking: {
            ...thinking,
            timeout: acknowledged,
            lastActivityAt: Math.max(
              thinking.lastActivityAt ?? 0,
              acknowledged.lastActivityAt,
            ),
          },
        };
      });
      currentPage.current = combined;
      setPage(combined);
    } catch (cause) {
      if (attempt === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (attempt === generation.current) {
        inflight.current = null;
        setLoading(false);
        if (queuedRefresh.current) {
          queuedRefresh.current = false;
          void load();
        }
      }
    }
  }, []);
  useEffect(() => {
    currentPage.current = null;
    inflight.current = null;
    queuedRefresh.current = false;
    acknowledgedTimeouts.current.clear();
    setPage(null);
    setError(null);
    setLoading(false);
    void load();
    return () => {
      generation.current += 1;
      inflight.current = null;
    };
  }, [sessionId, enabled, transport, load]);
  useEffect(() => {
    const previous = observedSnapshot.current;
    observedSnapshot.current = { running, snapshotIdentity };
    if (
      previous.running !== running ||
      previous.snapshotIdentity !== snapshotIdentity
    )
      void load();
  }, [running, snapshotIdentity, load]);
  const loadEarlier = useCallback(() => load(true), [load]);
  const reload = useCallback(() => load(), [load]);
  const updateTimeout = useCallback(
    (messageId: string, timeout: TaskExecutionTimeoutState) => {
      const current = currentPage.current;
      if (!current) return;
      const thinking = current.messages.find(
        ({ id }) => id === messageId,
      )?.thinking;
      if (
        thinking?.status !== "running" ||
        (thinking.timeout &&
          thinking.timeout.lastActivityAt > timeout.lastActivityAt)
      )
        return;
      acknowledgedTimeouts.current.set(messageId, timeout);
      const updated = {
        ...current,
        messages: current.messages.map((message) =>
          message.id === messageId && message.thinking?.status === "running"
            ? {
                ...message,
                thinking: {
                  ...message.thinking,
                  timeout,
                  lastActivityAt: timeout.lastActivityAt,
                },
              }
            : message,
        ),
      };
      currentPage.current = updated;
      setPage(updated);
    },
    [],
  );
  const thinking = useMemo(
    () =>
      new Map(
        (page?.messages ?? []).flatMap((message) =>
          message.thinking ? [[message.id, message.thinking] as const] : [],
        ),
      ),
    [page],
  );
  const executions = useMemo(
    () =>
      new Map(
        (page?.messages ?? []).flatMap((message) =>
          message.execution ? [[message.id, message.execution] as const] : [],
        ),
      ),
    [page],
  );
  return {
    messages: enabled && page ? page.messages : messages,
    thinking,
    executions,
    ready: !enabled || page !== null,
    hasEarlier: page?.hasEarlier ?? false,
    loading,
    error,
    loadEarlier,
    reload,
    updateTimeout,
  };
}
