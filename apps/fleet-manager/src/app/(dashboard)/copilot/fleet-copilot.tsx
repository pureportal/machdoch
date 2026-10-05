"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { api, jsonBody } from "@machdoch/product-ui/fleet-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import {
  fleetSessionRouteSchema,
  type FleetSessionRequest,
  type FleetSessionTarget,
} from "@/lib/fleet-session-routing";
import { useFleetStatus } from "../workspaces/use-fleet-status";

export function FleetCopilot(): React.ReactElement {
  const router = useRouter();
  const { status, loading, error, refresh } = useFleetStatus();
  const [targets, setTargets] = useState<FleetSessionTarget[]>([]);
  const [opening, setOpening] = useState(false);
  const [commandError, setCommandError] = useState("");
  const request = useRef<FleetSessionRequest | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  const devices = (status?.devices ?? []).filter(
    (device) =>
      device.online &&
      device.error === null &&
      device.canCreateSession &&
      device.versionStatus !== "incompatible" &&
      device.workspaces.length > 0,
  );

  const openSession = async (): Promise<void> => {
    if (inFlight.current || !targets.length) return;
    request.current ??= {
      commandId: crypto.randomUUID(),
      targets: structuredClone(targets),
    };
    const input = request.current;
    const controller = new AbortController();
    inFlight.current = controller;
    setOpening(true);
    setCommandError("");
    try {
      const route = fleetSessionRouteSchema.parse(
        await api("/api/fleet/sessions", {
          method: "POST",
          body: jsonBody(input),
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted) return;
      if (
        route.commandId !== input.commandId ||
        !input.targets.some(
          (target) =>
            target.instanceId === route.instanceId &&
            target.workspace === route.workspace,
        )
      )
        throw new Error(
          "The device returned a different session. Refresh and retry.",
        );
      router.push(
        `/instances/${encodeURIComponent(route.instanceId)}?session=${encodeURIComponent(route.sessionId)}`,
      );
    } catch (reason) {
      if (!controller.signal.aborted)
        setCommandError(
          reason instanceof Error
            ? reason.message
            : "Session could not be opened. Retry.",
        );
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
      if (!controller.signal.aborted) setOpening(false);
    }
  };

  return (
    <section className="grid gap-6">
      <PageHeader title="Copilot">
        <Button
          variant="outline"
          disabled={loading || opening}
          onClick={() => void refresh()}
        >
          <RefreshCw />
          Refresh
        </Button>
      </PageHeader>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {commandError ? (
        <p role="alert" className="text-sm text-destructive">
          {commandError}
        </p>
      ) : null}
      {!status ? (
        <p role="status">
          {loading ? "Loading workspaces…" : "Workspaces could not be loaded."}
        </p>
      ) : null}
      {status && !devices.length ? (
        <p role="status">No workspaces can open sessions.</p>
      ) : null}
      <fieldset disabled={opening || Boolean(error)} className="grid gap-4">
        <legend className="mb-3 font-medium">Workspaces</legend>
        {devices.map((device) => (
          <Card key={device.instanceId} className="grid gap-3 p-5">
            <h2 className="font-semibold">{device.displayName}</h2>
            {device.workspaces.map((workspace) => {
              const selected = targets.some(
                (target) =>
                  target.instanceId === device.instanceId &&
                  target.workspace === workspace.root,
              );
              return (
                <label
                  key={workspace.root}
                  className="flex min-w-0 items-center gap-3 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!selected && targets.length === 16}
                    onChange={(event) => {
                      request.current = null;
                      setCommandError("");
                      setTargets((current) =>
                        event.target.checked
                          ? [
                              ...current,
                              {
                                instanceId: device.instanceId,
                                workspace: workspace.root,
                              },
                            ]
                          : current.filter(
                              (target) =>
                                target.instanceId !== device.instanceId ||
                                target.workspace !== workspace.root,
                            ),
                      );
                    }}
                  />
                  <span className="[overflow-wrap:anywhere]">
                    {workspace.root}
                  </span>
                </label>
              );
            })}
          </Card>
        ))}
      </fieldset>
      <Button
        className="justify-self-start"
        disabled={opening || Boolean(error) || !targets.length}
        onClick={() => void openSession()}
      >
        {opening
          ? "Opening session…"
          : targets.length > 1
            ? "Open on least-busy device"
            : "Open session"}
      </Button>
    </section>
  );
}
