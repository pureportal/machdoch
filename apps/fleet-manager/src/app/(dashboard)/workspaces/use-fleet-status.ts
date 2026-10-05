"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@machdoch/product-ui/fleet-api";
import type { FleetStatus } from "@/lib/fleet-status";

export function useFleetStatus() {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      const next = await api<FleetStatus>("/api/fleet/status", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setStatus(next);
      setError(null);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Fleet status could not be loaded.",
        );
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const poll = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(poll, 10_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      pending.current?.abort();
      pending.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);
  return { status, loading, error, refresh };
}
