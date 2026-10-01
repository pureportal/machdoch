"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@machdoch/product-ui/fleet-api";

interface EnrollmentGrant {
  grantId: string;
  enrollmentKey: string;
  managerUrl: string;
  managerId: string;
  expiresAt: number;
}

interface AvailableGrant {
  grantId: string;
  createdAt: number;
  expiresAt: number;
}

export function useEnrollmentKeys() {
  const [grant, setGrant] = useState<EnrollmentGrant | null>(null);
  const [grants, setGrants] = useState<AvailableGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const inventoryRequest = useRef(0);
  const mutating = useRef(false);

  const reload = useCallback(async (): Promise<void> => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || mutating.current) return;
    const requestId = ++inventoryRequest.current;
    setLoading(true);
    try {
      const result = await api<{ grants: AvailableGrant[] }>(
        "/api/enrollment-keys",
        { signal },
      );
      if (signal.aborted || requestId !== inventoryRequest.current) return;
      setGrants(result.grants);
      setLoadError("");
      setGrant((current) =>
        current &&
        result.grants.some((item) => item.grantId === current.grantId)
          ? current
          : null,
      );
    } catch (reason) {
      if (!signal.aborted && requestId === inventoryRequest.current)
        setLoadError(
          reason instanceof Error
            ? reason.message
            : "Keys could not be loaded.",
        );
    } finally {
      if (!signal.aborted && requestId === inventoryRequest.current)
        setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    void reload();
    const refresh = (): void => {
      if (document.visibilityState === "visible") void reload();
    };
    const interval = window.setInterval(refresh, 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  useEffect(() => {
    if (!grant) return;
    const timeout = window.setTimeout(
      () => {
        setGrant(null);
        void reload();
      },
      Math.min(2_147_483_647, Math.max(0, grant.expiresAt * 1000 - Date.now())),
    );
    return () => window.clearTimeout(timeout);
  }, [grant, reload]);

  const create = async (): Promise<void> => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || mutating.current) return;
    mutating.current = true;
    inventoryRequest.current += 1;
    setPending(true);
    setError("");
    try {
      const created = await api<EnrollmentGrant>("/api/enrollment-keys", {
        method: "POST",
        signal,
      });
      if (!signal.aborted) setGrant(created);
    } catch (reason) {
      if (!signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Key creation failed.",
        );
    } finally {
      mutating.current = false;
      if (!signal.aborted) {
        setPending(false);
        void reload();
      }
    }
  };

  const revoke = async (grantId: string): Promise<void> => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || mutating.current) return;
    mutating.current = true;
    inventoryRequest.current += 1;
    setRevoking(grantId);
    setError("");
    try {
      await api(`/api/enrollment-keys/${encodeURIComponent(grantId)}`, {
        method: "DELETE",
        signal,
      });
      if (signal.aborted) return;
      setGrants((current) =>
        current.filter((item) => item.grantId !== grantId),
      );
      setGrant((current) => (current?.grantId === grantId ? null : current));
    } catch (reason) {
      if (!signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Key revocation failed.",
        );
    } finally {
      mutating.current = false;
      if (!signal.aborted) {
        setRevoking(null);
        void reload();
      }
    }
  };

  return {
    grant,
    grants,
    loading,
    pending,
    revoking,
    error,
    loadError,
    reload,
    create,
    revoke,
  };
}
