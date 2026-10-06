import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionIndexPage,
  SessionIndexQuery,
} from "@machdoch/fleet-protocol/session-data";
import type { SessionDataSource } from "./session-data";

export function useSessionIndex(
  source: SessionDataSource | undefined,
  query: SessionIndexQuery,
  snapshotIdentity: string,
) {
  const latest = useRef({ source, query });
  latest.current = { source, query };
  const generation = useRef(0);
  const running = useRef<number | null>(null);
  const currentPage = useRef<SessionIndexPage | null>(null);
  const snapshotAtMount = useRef(snapshotIdentity);
  const [page, setPage] = useState<SessionIndexPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = JSON.stringify(query);
  const load = useCallback(
    async (mode: "reset" | "refresh" | "more" = "refresh"): Promise<void> => {
      const current = latest.current;
      if (!current.source || (running.current !== null && mode !== "reset"))
        return;
      const attempt = ++generation.current;
      running.current = attempt;
      setLoading(true);
      setError(null);
      const previous = mode === "reset" ? null : currentPage.current;
      const targetCount =
        mode === "more"
          ? (previous?.sessions.length ?? 0) + current.query.limit
          : Math.max(current.query.limit, previous?.sessions.length ?? 0);
      try {
        let offset = 0;
        let combined: SessionIndexPage | null = null;
        do {
          const next = await current.source.index({ ...current.query, offset });
          if (attempt !== generation.current) return;
          if (
            combined &&
            JSON.stringify(combined.sessionIds) !==
              JSON.stringify(next.sessionIds)
          )
            throw new Error("The session list changed. Reload it.");
          combined = combined
            ? {
                ...next,
                sessions: [
                  ...new Map(
                    [...combined.sessions, ...next.sessions].map((session) => [
                      session.id,
                      session,
                    ]),
                  ).values(),
                ],
              }
            : next;
          if (next.nextOffset === null || next.nextOffset <= offset) break;
          offset = next.nextOffset;
        } while (combined.sessions.length < targetCount);
        currentPage.current = combined;
        setPage(combined);
      } catch (cause) {
        if (attempt === generation.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (attempt === generation.current) {
          running.current = null;
          setLoading(false);
        }
      }
    },
    [],
  );
  useEffect(() => {
    currentPage.current = null;
    setPage(null);
    void load("reset");
    return () => {
      generation.current += 1;
      running.current = null;
    };
  }, [source, identity, load]);
  useEffect(() => {
    if (snapshotAtMount.current === snapshotIdentity) return;
    snapshotAtMount.current = snapshotIdentity;
    void load();
  }, [snapshotIdentity, load]);
  useEffect(() => {
    if (!source) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [source, load]);
  const reload = useCallback(() => load(), [load]);
  const loadEarlier = useCallback(() => load("more"), [load]);
  return { page, loading, error, reload, loadEarlier };
}
