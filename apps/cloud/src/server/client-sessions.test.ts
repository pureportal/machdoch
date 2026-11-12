import {
  createFleetSessionId,
  gatewayProtocolVersion,
  type HostResponse,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { productFixture } from "../test/product-fixture";
import { createRemoteTestRuntime } from "../test/remote-fixture";
import { startClientSession } from "./client-sessions";
import { createSecret } from "./crypto";
import { nowSeconds } from "./database";
import type { FleetRuntime } from "./runtime";

let runtime: FleetRuntime;
let snapshot: ProductSnapshot;
let instanceId: string;
const access = {
  authorize: vi.fn(async () => undefined),
  signal: new AbortController().signal,
};

beforeEach(async () => {
  runtime = await createRemoteTestRuntime();
  runtime.gateways.close();
  runtime.gateways = {
    isOnline: vi.fn(() => true),
    supportsCapability: vi.fn(() => true),
    relay: vi.fn(),
    close: vi.fn(),
  } as unknown as FleetRuntime["gateways"];
  const enrollmentKey = createSecret("mch_enroll");
  await runtime.fleetStore.createEnrollmentGrant(enrollmentKey, nowSeconds(), {
    keyLifetimeSeconds: 900,
    maximumOutstandingKeys: 8,
  });
  instanceId = (
    await runtime.fleetStore.enrollInstance(
      {
        enrollmentKey,
        instanceSecret: createSecret("mch_instance"),
        displayName: "Studio",
        productVersion: "29.0.0",
        protocolVersion: gatewayProtocolVersion,
      },
      nowSeconds(),
    )
  ).instanceId;
  snapshot = productFixture();
  vi.mocked(runtime.gateways.relay).mockImplementation(
    async (_, input): Promise<HostResponse> => {
      if (input.type !== "executeProductCommand")
        return { type: "productSnapshot", snapshot: structuredClone(snapshot) };
      if (input.command.kind === "create-session")
        snapshot.shell!.sessions.push({
          ...snapshot.shell!.sessions[0]!,
          id: await createFleetSessionId(input.command.commandId!),
        });
      return {
        type: "commandAccepted",
        receipt: { commandId: input.command.commandId!, duplicate: false },
      };
    },
  );
});

afterEach(async () => {
  await runtime.database.close();
});

function commands() {
  return vi
    .mocked(runtime.gateways.relay)
    .mock.calls.flatMap(([, input]) =>
      input.type === "executeProductCommand" ? [input.command] : [],
    );
}

it("opens a session on the chosen workspace, names it and submits the prompt in goal mode", async () => {
  const started = await startClientSession(
    runtime,
    access,
    crypto.randomUUID(),
    {
      instanceId,
      workspace: "/projects/example",
      title: "PRD-4 Hero image",
      prompt: "Create the hero image and upload it.",
      goalObjective: "Create the hero image and upload it.",
    },
  );
  expect(started).toMatchObject({
    instanceId,
    displayName: "Studio",
    workspace: "/projects/example",
  });
  expect(commands()).toEqual([
    expect.objectContaining({ kind: "create-session" }),
    expect.objectContaining({
      kind: "rename-session",
      sessionId: started.sessionId,
      title: "PRD-4 Hero image",
    }),
    expect.objectContaining({
      kind: "submit-message",
      sessionId: started.sessionId,
      prompt: "Create the hero image and upload it.",
      goalObjective: "Create the hero image and upload it.",
      promptEnhancementMode: "off",
      interviewEnabled: false,
    }),
  ]);
  expect(access.authorize).toHaveBeenCalled();
});

it("submits a single task without a goal objective", async () => {
  await startClientSession(runtime, access, crypto.randomUUID(), {
    instanceId,
    workspace: "/projects/example",
    title: "Fix checks",
    prompt: "Fix the failing checks.",
    goalObjective: null,
  });
  const submitted = commands().find(
    (command) => command.kind === "submit-message",
  );
  expect(submitted).not.toHaveProperty("goalObjective");
});

it("stops before contacting the device when authorization fails", async () => {
  await expect(
    startClientSession(
      runtime,
      {
        authorize: async () => {
          throw new Error("denied");
        },
        signal: access.signal,
      },
      crypto.randomUUID(),
      {
        instanceId,
        workspace: "/projects/example",
        title: "Denied",
        prompt: "Nothing",
        goalObjective: null,
      },
    ),
  ).rejects.toThrow("denied");
  expect(commands()).toHaveLength(0);
});
