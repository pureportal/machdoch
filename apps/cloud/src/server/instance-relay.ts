import type { HostRequest, HostResponse } from "@machdoch/fleet-protocol";
import { canUseClient, type ClientUser } from "../lib/client-access";
import { validateId } from "./crypto";
import type { FleetInstance } from "./fleet-store";
import { HttpError } from "./errors";
import { GatewayError } from "./gateway";
import type { FleetRuntime } from "./runtime";

export async function relayInstanceRequest(
  runtime: FleetRuntime,
  instanceId: string,
  request: HostRequest,
  signal?: AbortSignal,
): Promise<HostResponse> {
  try {
    return await runtime.gateways.relay(instanceId, request, signal);
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    const failure = {
      offline: [503, "Instance is offline."],
      closed: [503, "Instance is offline."],
      cancelled: [408, "Request was cancelled."],
      timeout: [504, "Instance did not respond in time."],
      busy: [429, "Instance has too many active requests."],
      protocol: [502, "Instance returned an invalid gateway response."],
    }[error.reason] as [number, string];
    throw new HttpError(failure[0], failure[1]);
  }
}

export function throwHostError(
  response: Extract<HostResponse, { type: "error" }>,
): never {
  const status = {
    invalidRequest: 400,
    conflict: 409,
    unavailable: 503,
    internal: 502,
  }[response.code];
  throw new HttpError(status, response.message);
}

export async function requireManagedInstance(
  runtime: FleetRuntime,
  instanceId: string,
): Promise<FleetInstance> {
  if (!validateId(instanceId, "instance"))
    throw new HttpError(404, "Instance was not found.");
  const instance = await runtime.fleetStore.getInstance(instanceId);
  if (!instance || instance.revokedAt !== null)
    throw new HttpError(404, "Instance was not found.");
  return instance;
}

export async function requireUsableInstance(
  runtime: FleetRuntime,
  user: ClientUser,
  instanceId: string,
): Promise<FleetInstance> {
  const instance = await requireManagedInstance(runtime, instanceId);
  if (!canUseClient(user, instance))
    throw new HttpError(
      403,
      instance.ownerUserId
        ? "Only the person who signed in on this client can use it."
        : "Agent tasks are turned off for this client.",
    );
  return instance;
}
