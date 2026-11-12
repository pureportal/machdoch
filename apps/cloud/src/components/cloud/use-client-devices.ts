"use client";

import { useEffect, useState } from "react";
import { api } from "@machdoch/product-ui/fleet-api";

export interface ClientDevice {
  instanceId: string;
  displayName: string;
  status: "online" | "offline" | "revoked";
}

const refreshMs = 30_000;

export function sortDevices(devices: ClientDevice[]): ClientDevice[] {
  return devices
    .filter((device) => device.status !== "revoked")
    .sort(
      (left, right) =>
        Number(right.status === "online") - Number(left.status === "online") ||
        left.displayName.localeCompare(right.displayName, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
    );
}

export function useClientDevices(enabled: boolean): ClientDevice[] {
  const [devices, setDevices] = useState<ClientDevice[]>([]);
  useEffect(() => {
    if (!enabled) {
      setDevices([]);
      return;
    }
    const abort = new AbortController();
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void api<{ instances: ClientDevice[] }>("/api/instances", {
        signal: abort.signal,
      })
        .then((payload) => setDevices(sortDevices(payload.instances)))
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, refreshMs);
    document.addEventListener("visibilitychange", load);
    return () => {
      abort.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [enabled]);
  return devices;
}
