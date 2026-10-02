"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@machdoch/product-ui/fleet-api";
import {
  createEnrollmentInventory,
  type AvailableGrant,
} from "./enrollment-inventory";

interface EnrollmentGrant {
  grantId: string;
  enrollmentKey: string;
  managerUrl: string;
  managerId: string;
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
  const inventoryRef = useRef<ReturnType<
    typeof createEnrollmentInventory
  > | null>(null);

  const reload = useCallback(
    (): Promise<void> => inventoryRef.current?.refresh() ?? Promise.resolve(),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const inventory = createEnrollmentInventory({
      signal: controller.signal,
      read: async (signal) => {
        const result = await api<{ grants: AvailableGrant[] }>(
          "/api/enrollment-keys",
          { signal },
        );
        return result.grants;
      },
      onInventory: (grants) => {
        setGrants(grants);
        setGrant((current) =>
          current && grants.some((item) => item.grantId === current.grantId)
            ? current
            : null,
        );
      },
      onError: setLoadError,
      onLoading: setLoading,
    });
    inventoryRef.current = inventory;
    setPending(false);
    setRevoking(null);
    void inventory.refresh();
    const refresh = (): void => {
      if (document.visibilityState === "visible") void inventory.refresh();
    };
    const interval = window.setInterval(refresh, 10_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      if (inventoryRef.current === inventory) inventoryRef.current = null;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

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
    const inventory = inventoryRef.current;
    if (!inventory?.beginMutation()) return;
    const { signal } = inventory;
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
      if (!signal.aborted) {
        setPending(false);
        inventory.finishMutation();
      }
    }
  };

  const revoke = async (grantId: string): Promise<void> => {
    const inventory = inventoryRef.current;
    if (!inventory?.beginMutation()) return;
    const { signal } = inventory;
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
      if (!signal.aborted) {
        setRevoking(null);
        inventory.finishMutation();
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
