import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { FleetCliProductRuntime } from "../../src/cli/_helpers/cli-fleet-product.ts";
import { runFleetGatewayConnection } from "../../src/cli/_helpers/cli-fleet-gateway.ts";
import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import { handleApiRequest } from "../../../fleet-manager/src/server/api.ts";
import { createWebRequest } from "../../../fleet-manager/src/server/http-request.ts";
import {
  FleetDatabase,
  nowSeconds,
} from "../../../fleet-manager/src/server/database.ts";
import { AuthStore } from "../../../fleet-manager/src/server/auth-store.ts";
import { AuthenticationRateLimiter } from "../../../fleet-manager/src/server/authentication-rate-limiter.ts";
import { FleetStore } from "../../../fleet-manager/src/server/fleet-store.ts";
import { SettingsStore } from "../../../fleet-manager/src/server/settings-store.ts";
import { GatewayHub } from "../../../fleet-manager/src/server/gateway.ts";
import { createSecret } from "../../../fleet-manager/src/server/crypto.ts";
import {
  setRuntimeForTests,
  type FleetRuntime,
} from "../../../fleet-manager/src/server/runtime.ts";

export async function startVerificationFleet(workspaceRoot: string) {
  const database = new FleetDatabase(":memory:");
  const config: FleetRuntime["config"] = {
    schemaVersion: 1,
    externalBaseUrl: "http://localhost",
    listen: { address: "127.0.0.1", port: 43188 },
    database: { path: ":memory:" },
    sessionPolicy: {
      idleSeconds: 1800,
      absoluteSeconds: 43200,
      maximumConcurrentSessions: 8,
    },
    enrollmentPolicy: { keyLifetimeSeconds: 900, maximumOutstandingKeys: 8 },
    connectionPolicy: {
      requestTimeoutSeconds: 30,
      heartbeatTimeoutSeconds: 45,
    },
    settingsManager: {
      enabled: false,
      limits: {
        maximumProfiles: 64,
        maximumInstructionsPerProfile: 128,
        maximumPacksPerProfile: 128,
        maximumPromptsPerProfile: 128,
        maximumRevisionsPerProfile: 100,
        maximumDocumentBytes: 1048576,
        maximumSecretBytes: 8192,
      },
    },
  };
  const fleetStore = new FleetStore(database);
  const gateways = new GatewayHub(config, fleetStore);
  const runtime: FleetRuntime = {
    database,
    config,
    fleetStore,
    gateways,
    authStore: new AuthStore(database),
    authenticationRateLimiter: new AuthenticationRateLimiter(),
    settingsStore: new SettingsStore(database),
    settingsCipher: null,
  };
  setRuntimeForTests(runtime);
  const owner = { username: "verification", password: randomUUID() };
  runtime.authStore.seedOwner(owner.username, owner.password, nowSeconds());
  const enrollmentKey = createSecret("mch_enroll");
  const instanceSecret = createSecret("mch_instance");
  fleetStore.createEnrollmentGrant(
    enrollmentKey,
    nowSeconds(),
    config.enrollmentPolicy,
  );
  const instance = fleetStore.enrollInstance(
    {
      enrollmentKey,
      instanceSecret,
      displayName: "Verification",
      productVersion: "33.2.0",
      protocolVersion: gatewayProtocolVersion,
    },
    nowSeconds(),
  );
  const product = await FleetCliProductRuntime.create(workspaceRoot);
  const requests: { method: string; path: string; status: number }[] = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const request = await createWebRequest(
        incoming,
        config.externalBaseUrl,
        4 * 1024 * 1024,
      );
      const response = await handleApiRequest(request, {
        clientAddress: incoming.socket.remoteAddress ?? "127.0.0.1",
      });
      requests.push({
        method: incoming.method ?? "GET",
        path: new URL(request.url).pathname,
        status: response.status,
      });
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (name !== "set-cookie") outgoing.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => outgoing.writeHead(500).end());
  });
  server.on("upgrade", (request, socket, head) => {
    gateways.handleUpgrade(request, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://localhost:${address.port}`;
  config.externalBaseUrl = origin;
  const controller = new AbortController();
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const connection = runFleetGatewayConnection({
    config: {
      schemaVersion: 1,
      enabled: true,
      managerUrl: origin,
      managerId: database.managerId(),
      instanceId: instance.instanceId,
      instanceSecret,
      displayName: "Verification",
    },
    signal: controller.signal,
    productVersion: "33.2.0",
    onConnected: connected,
    handleRequest: (request) => product.handleRequest(request),
  });
  const stop = async (): Promise<void> => {
    controller.abort();
    await connection;
    await product.shutdown();
    gateways.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    setRuntimeForTests(undefined);
  };
  try {
    await Promise.race([
      ready,
      connection.then((result) => {
        throw new Error(result.message);
      }),
    ]);
    return { origin, instanceId: instance.instanceId, owner, requests, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
