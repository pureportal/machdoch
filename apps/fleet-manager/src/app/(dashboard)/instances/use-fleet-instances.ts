"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@machdoch/product-ui/fleet-api";
import type { FleetInstance } from "./fleet-overview";

export function useFleetInstances() {
  const [instances, setInstances] = useState<FleetInstance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const payload = await api<{ instances: FleetInstance[] }>(
        "/api/instances",
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setInstances(payload.instances);
      setUpdatedAt(Date.now() / 1000);
      setError("");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Devices could not be loaded.",
      );
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        request.current = null;
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = (): void => {
      if (!request.current && document.visibilityState === "visible")
        void load();
    };
    const interval = window.setInterval(refresh, 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
      request.current?.abort();
    };
  }, [load]);

  return { instances, loading, error, updatedAt, load };
}
