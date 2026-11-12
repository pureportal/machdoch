import { productCommandSchema } from "@machdoch/fleet-protocol";
import { derivedCommandId } from "./cloud/command-ids";
import { HttpError } from "./errors";
import { openFleetSession, type FleetSessionAccess } from "./fleet-sessions";
import { relayInstanceRequest, throwHostError } from "./instance-relay";
import type { FleetRuntime } from "./runtime";

export interface ClientSessionStart {
  instanceId: string;
  workspace: string;
  title: string;
  prompt: string;
  goalObjective: string | null;
}

export interface ClientSessionStarted {
  instanceId: string;
  sessionId: string;
  displayName: string;
  workspace: string;
}

async function execute(
  runtime: FleetRuntime,
  access: FleetSessionAccess,
  instanceId: string,
  command: unknown,
): Promise<void> {
  await access.authorize();
  const parsed = productCommandSchema.parse(command);
  const response = await relayInstanceRequest(
    runtime,
    instanceId,
    { type: "executeProductCommand", command: parsed },
    access.signal,
  );
  if (response.type === "error") throwHostError(response);
  if (
    response.type !== "commandAccepted" ||
    response.receipt.commandId !== parsed.commandId
  )
    throw new HttpError(
      502,
      "The device returned an invalid receipt. Open the device to check the session.",
    );
}

export async function startClientSession(
  runtime: FleetRuntime,
  access: FleetSessionAccess,
  commandId: string,
  input: ClientSessionStart,
): Promise<ClientSessionStarted> {
  const route = await openFleetSession(runtime, access, {
    commandId,
    targets: [{ instanceId: input.instanceId, workspace: input.workspace }],
  });
  await execute(runtime, access, route.instanceId, {
    kind: "rename-session",
    commandId: derivedCommandId(commandId, "client-session-title"),
    sessionId: route.sessionId,
    title: input.title,
  });
  await execute(runtime, access, route.instanceId, {
    kind: "submit-message",
    commandId: derivedCommandId(commandId, "client-session-prompt"),
    sessionId: route.sessionId,
    prompt: input.prompt,
    promptEnhancementMode: "off",
    interviewEnabled: false,
    ...(input.goalObjective ? { goalObjective: input.goalObjective } : {}),
  });
  return {
    instanceId: route.instanceId,
    sessionId: route.sessionId,
    displayName: route.displayName,
    workspace: route.workspace,
  };
}
