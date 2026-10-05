import { createHash } from "node:crypto";
import {
  createFleetSessionId,
  productSnapshotSchema,
} from "@machdoch/fleet-protocol";
import {
  selectFleetSessionTarget,
  type FleetSessionRequest,
  type FleetSessionRoute,
} from "../lib/fleet-session-routing";
import { nowSeconds, requiredString } from "./database";
import { HttpError } from "./errors";
import { collectFleetStatus } from "./fleet-status";
import {
  relayInstanceRequest,
  requireManagedInstance,
  throwHostError,
} from "./instance-relay";
import { requireMutation } from "./request-auth";
import type { FleetRuntime } from "./runtime";

const activeRequests = new WeakMap<
  FleetRuntime,
  Map<string, Promise<FleetSessionRoute>>
>();

export async function openFleetSession(
  runtime: FleetRuntime,
  request: Request,
  input: FleetSessionRequest,
): Promise<FleetSessionRoute> {
  requireMutation(runtime, request);
  let pending = activeRequests.get(runtime);
  if (!pending) {
    pending = new Map();
    activeRequests.set(runtime, pending);
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(input.targets))
    .digest("hex");
  const key = `${input.commandId}/${digest}`;
  const existing = pending.get(key);
  if (existing) {
    const route = await existing;
    requireMutation(runtime, request);
    requireManagedInstance(runtime, route.instanceId);
    request.signal.throwIfAborted();
    return route;
  }
  const operation = dispatchFleetSession(runtime, request, input, digest);
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    pending.delete(key);
  }
}

async function dispatchFleetSession(
  runtime: FleetRuntime,
  request: Request,
  input: FleetSessionRequest,
  digest: string,
): Promise<FleetSessionRoute> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  const readRoute = () =>
    runtime.database.get(
      "SELECT * FROM fleet_session_routes WHERE command_id = ?",
      input.commandId,
    );
  let row = readRoute();
  let claimed = false;
  if (!row) {
    const status = await collectFleetStatus(
      runtime,
      signal,
      new Set(input.targets.map((target) => target.instanceId)),
    );
    requireMutation(runtime, request);
    signal.throwIfAborted();
    const target = selectFleetSessionTarget(status.devices, input.targets);
    if (!target)
      throw new HttpError(
        503,
        "No selected workspace is online. Refresh and choose a connected workspace.",
      );
    requireManagedInstance(runtime, target.instanceId);
    claimed =
      runtime.database.run(
        "INSERT INTO fleet_session_routes (command_id, request_digest, instance_id, workspace, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(command_id) DO NOTHING",
        input.commandId,
        digest,
        target.instanceId,
        target.workspace,
        nowSeconds(),
      ) === 1;
    row = readRoute();
  }
  if (requiredString(row, "request_digest") !== digest)
    throw new HttpError(
      409,
      "This session request has different workspaces. Start a new session request.",
    );
  const instanceId = requiredString(row, "instance_id");
  const workspace = requiredString(row, "workspace");
  requireMutation(runtime, request);
  requireManagedInstance(runtime, instanceId);
  signal.throwIfAborted();
  const requestCreation = async (): Promise<void> => {
    const response = await relayInstanceRequest(
      runtime,
      instanceId,
      {
        type: "executeProductCommand",
        command: {
          kind: "create-session",
          commandId: input.commandId,
          workspace,
        },
      },
      signal,
    );
    requireMutation(runtime, request);
    requireManagedInstance(runtime, instanceId);
    signal.throwIfAborted();
    if (response.type === "error") throwHostError(response);
    if (
      response.type !== "commandAccepted" ||
      response.receipt.commandId !== input.commandId
    )
      throw new HttpError(
        502,
        "Device returned an invalid session receipt. Open the device to check its sessions.",
      );
  };
  if (claimed) await requestCreation();
  const sessionId = await createFleetSessionId(input.commandId);
  const confirmationDeadline = Date.now() + 8_000;
  let creationRequested = claimed;
  do {
    requireMutation(runtime, request);
    requireManagedInstance(runtime, instanceId);
    signal.throwIfAborted();
    const response = await relayInstanceRequest(
      runtime,
      instanceId,
      { type: "getProductSnapshot" },
      signal,
    );
    requireMutation(runtime, request);
    requireManagedInstance(runtime, instanceId);
    signal.throwIfAborted();
    if (response.type === "error") throwHostError(response);
    if (response.type !== "productSnapshot")
      throw new HttpError(
        502,
        "Device returned invalid session data. Open the device to check its sessions.",
      );
    const snapshot = productSnapshotSchema.parse(response.snapshot);
    const session = snapshot.shell?.sessions.find(
      (session) => session.id === sessionId,
    );
    if (session) {
      if (session.workspace !== workspace || session.archivedAt !== undefined)
        break;
      runtime.database.run(
        "UPDATE fleet_session_routes SET session_id = ? WHERE command_id = ?",
        session.id,
        input.commandId,
      );
      return {
        commandId: input.commandId,
        instanceId,
        workspace,
        displayName: runtime.fleetStore.getInstance(instanceId)!.displayName,
        sessionId: session.id,
      };
    }
    if (typeof row?.session_id === "string") break;
    if (!creationRequested) {
      if (
        !snapshot.enabled ||
        !snapshot.shell?.sessionRoutingAvailable ||
        !snapshot.shell.workspaces.some((entry) => entry.root === workspace)
      )
        throw new HttpError(
          409,
          "This workspace cannot open sessions. Open the device to check its settings.",
        );
      await requestCreation();
      creationRequested = true;
      continue;
    }
    if (Date.now() >= confirmationDeadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < confirmationDeadline);
  throw new HttpError(
    409,
    "Session creation could not be confirmed. Retry or open the device to check its sessions.",
  );
}
