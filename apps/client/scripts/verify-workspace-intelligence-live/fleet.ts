import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { FleetCliProductRuntime } from "../../src/cli/_helpers/cli-fleet-product.ts";
import { runFleetGatewayConnection } from "../../src/cli/_helpers/cli-fleet-gateway.ts";
import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import { handleApiRequest } from "../../../cloud/src/server/api.ts";
import { createWebRequest } from "../../../cloud/src/server/http-request.ts";
import {
  FleetDatabase,
  nowSeconds,
} from "../../../cloud/src/server/database.ts";
import {
  createTestCloudDatabase,
  verifyTestSession,
} from "../../../cloud/src/server/cloud/test-database.ts";
import { cloudSessionCookie } from "../../../cloud/src/server/cloud/identity.ts";
import { initializeInstallation } from "../../../cloud/src/server/cloud/installation-storage.ts";
import { cloudCredentialsCipher } from "../../../cloud/src/server/cloud/credential-storage.ts";
import {
  createCloudRuntime,
  setCloudRuntimeForTests,
} from "../../../cloud/src/server/cloud/runtime.ts";
import { runtimeConfig } from "../../../cloud/src/server/config.ts";
import { FleetStore } from "../../../cloud/src/server/fleet-store.ts";
import { SettingsStore } from "../../../cloud/src/server/settings-store.ts";
import { verifySettingsCipher } from "../../../cloud/src/server/settings-crypto.ts";
import { GatewayHub } from "../../../cloud/src/server/gateway.ts";
import { createSecret } from "../../../cloud/src/server/crypto.ts";
import {
  setRuntimeForTests,
  type FleetRuntime,
} from "../../../cloud/src/server/runtime.ts";

export async function startVerificationFleet(workspaceRoot: string) {
  const requests: { method: string; path: string; status: number }[] = [];
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const request = await createWebRequest(
        incoming,
        runtime.config.externalBaseUrl,
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
      const session = cookies
        .find((value) => value.startsWith(`${cloudSessionCookie}=`))
        ?.split(";", 1)[0]
        ?.slice(cloudSessionCookie.length + 1);
      if (session) await verifyTestSession(cloudDatabase, session);
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => outgoing.writeHead(500).end());
  });
  server.on("upgrade", (request, socket, head) => {
    runtime.gateways
      .handleUpgrade(request, socket, head)
      .catch(() => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://localhost:${address.port}`;

  const cloudDatabase = await createTestCloudDatabase();
  const database = new FleetDatabase(cloudDatabase);
  await database.initialize();
  const installation = await initializeInstallation(cloudDatabase);
  const settingsCipher = cloudCredentialsCipher(installation.credentials_key);
  assert.ok(settingsCipher);
  const cloud = createCloudRuntime(cloudDatabase, origin, {
    credentialsCipher: settingsCipher,
  });
  const owner = { email: "verification@example.test", password: randomUUID() };
  await cloud.identity.bootstrap({
    organization: "Verification",
    name: "Verification",
    email: owner.email,
    password: owner.password,
    origin,
  });
  setCloudRuntimeForTests(cloud);
  const config = runtimeConfig(origin);
  const fleetStore = new FleetStore(database);
  await verifySettingsCipher(database, settingsCipher);
  const runtime: FleetRuntime = {
    config,
    database,
    fleetStore,
    settingsStore: new SettingsStore(database),
    settingsCipher,
    gateways: new GatewayHub(config, fleetStore),
  };
  setRuntimeForTests(runtime);

  const enrollmentKey = createSecret("mch_enroll");
  const instanceSecret = createSecret("mch_instance");
  await fleetStore.createEnrollmentGrant(
    enrollmentKey,
    nowSeconds(),
    config.enrollmentPolicy,
  );
  const instance = await fleetStore.enrollInstance(
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
      managerId: await database.managerId(),
      instanceId: instance.instanceId,
      instanceSecret,
      displayName: "Verification",
    },
    signal: controller.signal,
    productVersion: "33.2.0",
    onConnected: connected,
    handleRequest: (request) =>
      request.type === "installUpdate"
        ? Promise.resolve({
            type: "error",
            code: "unavailable",
            message: "Updates are not available during verification.",
          })
        : product.handleRequest(request),
  });
  const stop = async (): Promise<void> => {
    controller.abort();
    await connection;
    await product.shutdown();
    runtime.gateways.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await database.close();
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
