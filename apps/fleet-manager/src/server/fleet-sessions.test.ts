import {
  createFleetSessionId,
  gatewayProtocolVersion,
  type HostRequest,
  type HostResponse,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FleetSessionRequest } from "../lib/fleet-session-routing";
import { productFixture } from "../test/product-fixture";
import { AuthStore } from "./auth-store";
import { createSecret } from "./crypto";
import { FleetDatabase, nowSeconds } from "./database";
import { FleetStore } from "./fleet-store";
import { openFleetSession } from "./fleet-sessions";
import {
  createBrowserCredentials,
  csrfCookie,
  sessionCookie,
} from "./request-auth";
import type { FleetRuntime } from "./runtime";

let runtime: FleetRuntime;
let request: Request;
let snapshots: Map<string, ProductSnapshot>;

beforeEach(async () => {
  const database = new FleetDatabase(":memory:");
  const sessionPolicy = {
    idleSeconds: 1800,
    absoluteSeconds: 43_200,
    maximumConcurrentSessions: 8,
  };
  const authStore = new AuthStore(database);
  runtime = {
    database,
    authStore,
    fleetStore: new FleetStore(database),
    config: { externalBaseUrl: "https://fleet.example.test", sessionPolicy },
    gateways: { isOnline: vi.fn(() => true), relay: vi.fn() },
  } as unknown as FleetRuntime;
  const credentials = createBrowserCredentials();
  authStore.seedOwner("owner", "a secure test password", nowSeconds());
  await authStore.createOwnerSessionForCredentials(
    "owner",
    "a secure test password",
    credentials.sessionToken,
    credentials.csrfToken,
    "Test",
    nowSeconds(),
    sessionPolicy,
  );
  request = new Request("https://fleet.example.test/api/fleet/sessions", {
    method: "POST",
    headers: {
      Origin: "https://fleet.example.test",
      Cookie: `${sessionCookie(credentials.sessionToken, 1800).split(";")[0]}; ${csrfCookie(credentials.csrfToken, 1800).split(";")[0]}`,
      "X-Machdoch-Fleet-CSRF": credentials.csrfToken,
    },
  });
  snapshots = new Map();
  vi.mocked(runtime.gateways.relay).mockImplementation(
    async (instanceId, input): Promise<HostResponse> => {
      const snapshot = snapshots.get(instanceId)!;
      if (input.type === "executeProductCommand") {
        expect(input.command.kind).toBe("create-session");
        const session = {
          ...snapshot.shell!.sessions[0]!,
          id: await createFleetSessionId(input.command.commandId!),
        };
        snapshot.shell!.sessions.push(session);
        snapshot.commands.push({
          commandId: input.command.commandId!,
          kind: "create-session",
          sessionId: session.id,
          createdAt: Date.now(),
        });
        return {
          type: "commandAccepted",
          receipt: { commandId: input.command.commandId!, duplicate: false },
        };
      }
      return { type: "productSnapshot", snapshot: structuredClone(snapshot) };
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  runtime.database.close();
});

function enrollDevice(displayName = "Device"): string {
  const enrollmentKey = createSecret("mch_enroll");
  runtime.fleetStore.createEnrollmentGrant(enrollmentKey, nowSeconds(), {
    keyLifetimeSeconds: 900,
    maximumOutstandingKeys: 8,
  });
  const device = runtime.fleetStore.enrollInstance(
    {
      enrollmentKey,
      instanceSecret: createSecret("mch_instance"),
      displayName,
      productVersion: "29.0.0",
      protocolVersion: gatewayProtocolVersion,
    },
    nowSeconds(),
  );
  snapshots.set(device.instanceId, productFixture());
  return device.instanceId;
}

function sessionRequest(instanceIds: string[]): FleetSessionRequest {
  return {
    commandId: crypto.randomUUID(),
    targets: instanceIds.map((instanceId) => ({
      instanceId,
      workspace: "/projects/example",
    })),
  };
}

function commandCalls() {
  return vi
    .mocked(runtime.gateways.relay)
    .mock.calls.filter(([, input]) => input.type === "executeProductCommand");
}

describe("durable fleet session routing", () => {
  it("pins the least busy selected device and reuses the route across concurrent requests and restarts", async () => {
    const busy = enrollDevice("Busy");
    const idle = enrollDevice("Idle");
    snapshots.get(busy)!.sessions = [
      {
        taskId: "task-1",
        task: "Work",
        mode: "machdoch",
        state: "running",
        message: "",
        cancellable: true,
        startedAt: 1,
        updatedAt: 1,
        progressCount: 0,
        logs: [],
        timeline: [],
      },
    ];
    const input = sessionRequest([busy, idle]);
    const [first, second] = await Promise.all([
      openFleetSession(runtime, request, input),
      openFleetSession(runtime, request, input),
    ]);
    expect(first).toEqual(second);
    expect(first.instanceId).toBe(idle);
    expect(commandCalls()).toHaveLength(1);
    snapshots.get(idle)!.commands = [];
    const restartedRuntime = { ...runtime };
    expect(await openFleetSession(restartedRuntime, request, input)).toEqual(
      first,
    );
    expect(commandCalls()).toHaveLength(1);
  });

  it("recovers a lost receipt without sending a second creation command", async () => {
    const instanceId = enrollDevice();
    const input = sessionRequest([instanceId]);
    const relay = vi.mocked(runtime.gateways.relay);
    const handle = relay.getMockImplementation()!;
    relay.mockImplementation(async (id, payload, signal) => {
      const response = await handle(id, payload, signal);
      if (payload.type === "executeProductCommand")
        throw new Error("Connection lost after creation");
      return response;
    });
    await expect(openFleetSession(runtime, request, input)).rejects.toThrow(
      "Connection lost",
    );
    const route = await openFleetSession(runtime, request, input);
    expect(route.instanceId).toBe(instanceId);
    expect(commandCalls()).toHaveLength(1);
  });

  it("keeps the pinned identity when retrying an unconfirmed creation", async () => {
    const instanceId = enrollDevice();
    const input = sessionRequest([instanceId]);
    const relay = vi.mocked(runtime.gateways.relay);
    const handle = relay.getMockImplementation()!;
    vi.useFakeTimers({ toFake: ["Date"] });
    relay.mockImplementation(async (id, payload, signal) => {
      if (payload.type === "executeProductCommand")
        return {
          type: "commandAccepted",
          receipt: { commandId: input.commandId, duplicate: false },
        };
      const response = await handle(id, payload, signal);
      vi.setSystemTime(Date.now() + 9_000);
      return response;
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(openFleetSession(runtime, request, input)).rejects.toThrow(
        "could not be confirmed",
      );
    }
    expect(commandCalls()).toHaveLength(2);
    expect(commandCalls().map(([id, payload]) => [id, payload])).toEqual([
      [
        instanceId,
        {
          type: "executeProductCommand",
          command: {
            kind: "create-session",
            commandId: input.commandId,
            workspace: input.targets[0]!.workspace,
          },
        },
      ],
      [
        instanceId,
        {
          type: "executeProductCommand",
          command: {
            kind: "create-session",
            commandId: input.commandId,
            workspace: input.targets[0]!.workspace,
          },
        },
      ],
    ]);
  });

  it("recovers a persisted route when the original command never reached the device", async () => {
    const instanceId = enrollDevice();
    const input = sessionRequest([instanceId]);
    const relay = vi.mocked(runtime.gateways.relay);
    const handle = relay.getMockImplementation()!;
    let failed = false;
    relay.mockImplementation(async (id, payload, signal) => {
      if (payload.type === "executeProductCommand" && !failed) {
        failed = true;
        throw new Error("Connection lost before dispatch");
      }
      return handle(id, payload, signal);
    });
    await expect(openFleetSession(runtime, request, input)).rejects.toThrow(
      "before dispatch",
    );
    const restartedRuntime = { ...runtime };
    const route = await openFleetSession(restartedRuntime, request, input);
    expect(route.sessionId).toBe(await createFleetSessionId(input.commandId));
    expect(route.instanceId).toBe(instanceId);
    expect(commandCalls()).toHaveLength(2);
    expect(
      snapshots
        .get(instanceId)!
        .shell!.sessions.filter((session) => session.id === route.sessionId),
    ).toHaveLength(1);
  });

  it("waits for a queued desktop session without relying on command history", async () => {
    const instanceId = enrollDevice();
    const input = sessionRequest([instanceId]);
    const relay = vi.mocked(runtime.gateways.relay);
    const handle = relay.getMockImplementation()!;
    let queued = false;
    relay.mockImplementation(async (id, payload, signal) => {
      if (payload.type === "executeProductCommand") {
        queued = true;
        return {
          type: "commandAccepted",
          receipt: { commandId: input.commandId, duplicate: false },
        };
      }
      const response = await handle(id, payload, signal);
      if (queued) {
        snapshots.get(id)!.shell!.sessions.push({
          ...snapshots.get(id)!.shell!.sessions[0]!,
          id: await createFleetSessionId(input.commandId),
        });
        queued = false;
      }
      return response;
    });
    const route = await openFleetSession(runtime, request, input);
    expect(route.sessionId).toBe(await createFleetSessionId(input.commandId));
    expect(commandCalls()).toHaveLength(1);
    expect(snapshots.get(instanceId)!.commands).toEqual([]);
  });

  it("refuses to change the target scope under an existing command ID", async () => {
    const first = enrollDevice();
    const second = enrollDevice();
    const input = sessionRequest([first]);
    await openFleetSession(runtime, request, input);
    await expect(
      openFleetSession(runtime, request, {
        ...input,
        targets: sessionRequest([second]).targets,
      }),
    ).rejects.toThrow("different workspaces");
    expect(commandCalls()).toHaveLength(1);
  });

  it("refuses unknown workspace paths without dispatching a command", async () => {
    const instanceId = enrollDevice();
    const input = sessionRequest([instanceId]);
    input.targets[0]!.workspace = "/private/unlisted";
    await expect(openFleetSession(runtime, request, input)).rejects.toThrow(
      "No selected workspace",
    );
    expect(commandCalls()).toHaveLength(0);
  });

  it("stops before creation when the owner is revoked during status collection", async () => {
    const instanceId = enrollDevice();
    vi.mocked(runtime.gateways.relay).mockImplementation(async () => {
      runtime.database.run("DELETE FROM owner_sessions");
      return { type: "productSnapshot", snapshot: productFixture() };
    });
    await expect(
      openFleetSession(runtime, request, sessionRequest([instanceId])),
    ).rejects.toMatchObject({ status: 401 });
    expect(commandCalls()).toHaveLength(0);
    expect(runtime.database.all("SELECT * FROM fleet_session_routes")).toEqual(
      [],
    );
  });

  it.each(["owner", "device"])(
    "does not disclose a session after %s revocation during creation",
    async (revoked) => {
      const instanceId = enrollDevice();
      const relay = vi.mocked(runtime.gateways.relay);
      const handle = relay.getMockImplementation()!;
      relay.mockImplementation(
        async (id: string, payload: HostRequest, signal?: AbortSignal) => {
          const response = await handle(id, payload, signal);
          if (payload.type === "executeProductCommand") {
            if (revoked === "owner")
              runtime.database.run("DELETE FROM owner_sessions");
            else runtime.fleetStore.revokeInstance(instanceId, nowSeconds());
          }
          return response;
        },
      );
      await expect(
        openFleetSession(runtime, request, sessionRequest([instanceId])),
      ).rejects.toMatchObject({ status: revoked === "owner" ? 401 : 404 });
      expect(relay.mock.calls).toHaveLength(2);
    },
  );

  it("requires owner authentication, same-origin CSRF, and an active request", async () => {
    const instanceId = enrollDevice();
    const input = sessionRequest([instanceId]);
    await expect(
      openFleetSession(
        runtime,
        new Request(request.url, { method: "POST" }),
        input,
      ),
    ).rejects.toMatchObject({ status: 401 });
    const forged = new Request(request);
    forged.headers.set("Origin", "https://attacker.example");
    await expect(
      openFleetSession(runtime, forged, input),
    ).rejects.toMatchObject({ status: 403 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      openFleetSession(
        runtime,
        new Request(request, { signal: controller.signal }),
        input,
      ),
    ).rejects.toThrow();
    expect(commandCalls()).toHaveLength(0);
  });
});
