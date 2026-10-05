import type { HostRequest, HostResponse } from "@machdoch/fleet-protocol";
import { validateId } from "./crypto";
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

export function requireManagedInstance(
  runtime: FleetRuntime,
  instanceId: string,
): void {
  if (!validateId(instanceId, "instance"))
    throw new HttpError(404, "Instance was not found.");
  const instance = runtime.fleetStore.getInstance(instanceId);
  if (!instance || instance.revokedAt !== null)
    throw new HttpError(404, "Instance was not found.");
}
