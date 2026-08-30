import { createServer } from "node:http";
import {
  gatewayProtocolVersion,
  productCapability,
  type ManagerMessage,
} from "@machdoch/fleet-protocol";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { FleetManagerConfig } from "./config";
import { createSecret } from "./crypto";
import { FleetDatabase, nowSeconds } from "./database";
import { FleetStore } from "./fleet-store";
import { GatewayHub } from "./gateway";

let database: FleetDatabase | null = null;
let hub: GatewayHub | null = null;

afterEach(() => {
  hub?.close();
  database?.close();
  hub = null;
  database = null;
});

describe("outbound gateway relay", () => {
  it("authenticates an enrolled client and correlates remote responses", async () => {
    const config = testConfig();
    database = new FleetDatabase(":memory:");
    const store = new FleetStore(database);
    hub = new GatewayHub(config, store);
    const enrollmentKey = createSecret("mch_enroll");
    const instanceSecret = createSecret("mch_instance");
    store.createEnrollmentGrant(
      enrollmentKey,
      nowSeconds(),
      config.enrollmentPolicy,
    );
    const instance = store.enrollInstance(
      {
        enrollmentKey,
        instanceSecret,
        displayName: "Workstation",
        productVersion: "6.3.0",
        protocolVersion: gatewayProtocolVersion,
      },
      nowSeconds(),
    );

    const server = createServer((_request, response) =>
      response.writeHead(404).end(),
    );
    server.on("upgrade", (request, socket, head) =>
      hub?.handleUpgrade(request, socket, head),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server address is invalid.");
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/gateway/connect/${instance.instanceId}`,
      { headers: { Authorization: `Bearer ${instanceSecret}` } },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        instanceId: instance.instanceId,
        protocolVersion: gatewayProtocolVersion,
        productVersion: "6.3.0",
        capabilities: [productCapability],
      }),
    );
    await waitUntil(() => hub?.isOnline(instance.instanceId) === true);
    const outbound = new Promise<ManagerMessage>((resolve) => {
      socket.once("message", (data) =>
        resolve(JSON.parse(data.toString()) as ManagerMessage),
      );
    });
    const relayed = hub.relay(instance.instanceId, {
      type: "getProductSnapshot",
    });
    const message = await outbound;
    expect(message).toMatchObject({
      type: "request",
      request: { type: "getProductSnapshot" },
    });
    if (message.type !== "request")
      throw new Error("Expected a gateway request.");
    socket.send(
      JSON.stringify({
        type: "response",
        requestId: message.requestId,
        response: {
          type: "productSnapshot",
          snapshot: {
            enabled: true,
            serverTime: 1,
            eventId: 1,
            sessions: [],
            commands: [],
          },
        },
      }),
    );
    await expect(relayed).resolves.toMatchObject({
      type: "productSnapshot",
      snapshot: { enabled: true, eventId: 1 },
    });
    socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for gateway connection.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function testConfig(): FleetManagerConfig {
  return {
    schemaVersion: 1,
    externalBaseUrl: "https://fleet.example.test",
    listen: { address: "127.0.0.1", port: 43188 },
    database: { path: ":memory:" },
    sessionPolicy: {
      idleSeconds: 1800,
      absoluteSeconds: 43_200,
      maximumConcurrentSessions: 8,
    },
    enrollmentPolicy: { keyLifetimeSeconds: 900, maximumOutstandingKeys: 8 },
    connectionPolicy: { requestTimeoutSeconds: 1, heartbeatTimeoutSeconds: 45 },
    settingsManager: {
      enabled: false,
      limits: {
        maximumProfiles: 64,
        maximumInstructionsPerProfile: 128,
        maximumPacksPerProfile: 128,
        maximumRevisionsPerProfile: 100,
        maximumDocumentBytes: 1024 * 1024,
        maximumSecretBytes: 8192,
      },
    },
  };
}
