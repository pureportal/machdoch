"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import {
  fleetSessionRouteSchema,
  type FleetSessionRequest,
  type FleetSessionTarget,
} from "@/lib/fleet-session-routing";

export function useOpenFleetSession(): (
  targets: FleetSessionTarget[],
) => Promise<void> {
  const router = useRouter();
  const lastRequest = useRef<FleetSessionRequest | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  return async (targets) => {
    if (inFlight.current) return;
    const retry =
      lastRequest.current !== null &&
      JSON.stringify(lastRequest.current.targets) === JSON.stringify(targets);
    const request: FleetSessionRequest = retry
      ? lastRequest.current!
      : { commandId: crypto.randomUUID(), targets: structuredClone(targets) };
    lastRequest.current = request;
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const route = fleetSessionRouteSchema.parse(
        await api("/api/fleet/sessions", {
          method: "POST",
          body: jsonBody(request),
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted) return;
      if (
        route.commandId !== request.commandId ||
        !request.targets.some(
          (target) =>
            target.instanceId === route.instanceId &&
            target.workspace === route.workspace,
        )
      )
        throw new Error(
          "The device returned a different session. Refresh and retry.",
        );
      lastRequest.current = null;
      router.push(
        `/instances/${encodeURIComponent(route.instanceId)}?session=${encodeURIComponent(route.sessionId)}`,
      );
    } catch (reason) {
      if (controller.signal.aborted) return;
      throw reason instanceof Error
        ? reason
        : new Error("Session could not be opened. Retry.");
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  };
}
