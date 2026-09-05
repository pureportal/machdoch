import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  gatewayProtocolVersion,
  productCapability,
  type ManagerMessage,
} from "@machdoch/fleet-protocol";
import { WebSocket, type WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetManagerConfig } from "./config";
import { createSecret } from "./crypto";
import { FleetDatabase, nowSeconds } from "./database";
import { FleetStore } from "./fleet-store";
import { GatewayHub } from "./gateway";

let database: FleetDatabase | null = null;
let hub: GatewayHub | null = null;
const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  hub?.close();
  sockets.splice(0).forEach((socket) => socket.terminate());
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  database?.close();
  hub = null;
  database = null;
});

describe("gateway failure recovery and resource limits", () => {
  it("allows bounded preview receipt bursts without disconnecting the control channel", async () => {
    const fixture = await gatewayFixture(true, true);
    for (let i = 0; i < 600; i++)
      fixture.socket.send(
        JSON.stringify({ type: "heartbeat", sentAt: Date.now() }),
      );
    const incoming = nextMessage(fixture.socket);
    const response = hub!.relay(fixture.instanceId, {
      type: "getProductSnapshot",
    });
    const request = await incoming;
    if (request.type !== "request") throw new Error("Expected request");
    fixture.socket.send(
      JSON.stringify({
        type: "response",
        requestId: request.requestId,
        response: {
          type: "error",
          code: "unavailable",
          message: "Still connected",
        },
      }),
    );
    await expect(response).resolves.toMatchObject({
      message: "Still connected",
    });
    expect(hub!.isOnline(fixture.instanceId)).toBe(true);
  });
  it("terminates peers that never complete the close handshake", async () => {
    const fixture = await gatewayFixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(fixture.serverSocket, "close").mockImplementation(() => undefined);
    const terminate = vi.spyOn(fixture.serverSocket, "terminate");
    hub!.disconnect(fixture.instanceId, "Instance was revoked.");
    expect(hub!.isOnline(fixture.instanceId)).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(terminate).toHaveBeenCalledOnce();
  });
  it("handles reset errors on rejected upgrade sockets", () => {
    database = new FleetDatabase(":memory:");
    hub = new GatewayHub(testConfig(), new FleetStore(database));
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    expect(
      hub.handleUpgrade(
        { url: "/api/gateway/connect/invalid", headers: {} } as IncomingMessage,
        socket,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(() =>
      socket.emit("error", new Error("connection reset")),
    ).not.toThrow();
    expect(socket.destroyed).toBe(true);
  });
  it("reconnects after manager restart without sending a permanent disconnect", async () => {
    const fixture = await gatewayFixture();
    const messages: unknown[] = [];
    fixture.socket.on("message", (data) =>
      messages.push(JSON.parse(data.toString())),
    );
    const pending = hub!
      .relay(fixture.instanceId, { type: "getProductSnapshot" })
      .catch((error: unknown) => error);
    const closed = onClose(fixture.socket);
    hub!.close();
    expect(hub!.isOnline(fixture.instanceId)).toBe(false);
    expect(await pending).toMatchObject({ reason: "closed" });
    expect((await closed).code).toBe(1012);
    expect(messages).not.toContainEqual(
      expect.objectContaining({ type: "disconnect" }),
    );
    hub = new GatewayHub(testConfig(), fixture.store);
    await fixture.connect();
    expect(hub.isOnline(fixture.instanceId)).toBe(true);
  });

  it("rejects duplicate and revoked credentials while preserving the healthy connection", async () => {
    const fixture = await gatewayFixture();
    await expect(fixture.connect()).rejects.toThrow("409");
    expect(hub!.isOnline(fixture.instanceId)).toBe(true);
    fixture.store.revokeInstance(fixture.instanceId, nowSeconds());
    hub!.disconnect(fixture.instanceId, "Instance was revoked.");
    await expect(fixture.connect()).rejects.toThrow("401");
  });

  it("rejects mismatched receipts and releases other pending requests immediately", async () => {
    const fixture = await gatewayFixture();
    const outbound = nextMessage(fixture.socket);
    const command = hub!
      .relay(fixture.instanceId, {
        type: "executeProductCommand",
        command: { kind: "cancel", taskId: "task-1", commandId: "command-1" },
      })
      .catch((error: unknown) => error);
    const snapshot = hub!
      .relay(fixture.instanceId, { type: "getProductSnapshot" })
      .catch((error: unknown) => error);
    const request = await outbound;
    if (request.type !== "request") throw new Error("Expected a request.");
    fixture.socket.send(
      JSON.stringify({
        type: "response",
        requestId: request.requestId,
        response: {
          type: "commandAccepted",
          receipt: { commandId: "another-command", duplicate: false },
        },
      }),
    );
    expect(await command).toMatchObject({ reason: "protocol" });
    expect(await snapshot).toMatchObject({ reason: "closed" });
    expect(hub!.isOnline(fixture.instanceId)).toBe(false);
  });

  it("bounds pending requests and frees all slots when browser requests abort", async () => {
    const fixture = await gatewayFixture();
    const controller = new AbortController();
    // One shared signal represents a disconnected HTTP client with several active requests.
    const { setMaxListeners } = await import("node:events");
    setMaxListeners(0, controller.signal);
    const pending = Array.from({ length: 64 }, () =>
      hub!
        .relay(
          fixture.instanceId,
          { type: "getProductSnapshot" },
          controller.signal,
        )
        .catch((error: unknown) => error),
    );
    await expect(
      hub!.relay(fixture.instanceId, { type: "getProductSnapshot" }),
    ).rejects.toMatchObject({ reason: "busy" });
    controller.abort();
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 64 }, () =>
        expect.objectContaining({ reason: "cancelled" }),
      ),
    );
    const { getEventListeners } = await import("node:events");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const next = new AbortController();
    const request = hub!
      .relay(fixture.instanceId, { type: "getProductSnapshot" }, next.signal)
      .catch((error: unknown) => error);
    next.abort();
    expect(await request).toMatchObject({ reason: "cancelled" });
    await expect(
      hub!.relay(
        fixture.instanceId,
        { type: "getProductSnapshot" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("limits buffered writes before a slow peer can grow memory", async () => {
    const fixture = await gatewayFixture();
    vi.spyOn(fixture.serverSocket, "bufferedAmount", "get").mockReturnValue(
      8 * 1024 * 1024,
    );
    const send = vi.spyOn(fixture.serverSocket, "send");
    await expect(
      hub!.relay(fixture.instanceId, { type: "getProductSnapshot" }),
    ).rejects.toMatchObject({ reason: "busy" });
    expect(send).not.toHaveBeenCalled();
  });

  it("handles asynchronous write failures without retaining pending requests", async () => {
    const fixture = await gatewayFixture();
    vi.spyOn(fixture.serverSocket, "send").mockImplementation(
      (...arguments_: unknown[]) => {
        const callback = arguments_.at(-1);
        if (typeof callback === "function")
          queueMicrotask(() => callback(new Error("broken pipe")));
      },
    );
    await expect(
      hub!.relay(fixture.instanceId, { type: "getProductSnapshot" }),
    ).rejects.toMatchObject({ reason: "closed" });
    expect(hub!.isOnline(fixture.instanceId)).toBe(false);
  });

  it("releases stale connections before a peer acknowledges the close", async () => {
    const fixture = await gatewayFixture();
    const initial = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(initial + 46_000);
    expect(hub!.isOnline(fixture.instanceId)).toBe(false);
    checkConnections();
    await fixture.connect();
    expect(hub!.isOnline(fixture.instanceId)).toBe(true);
  });

  it("does not let pre-hello pings extend the authentication deadline", async () => {
    const fixture = await gatewayFixture(false);
    const initial = performance.now();
    const monotonic = vi
      .spyOn(performance, "now")
      .mockReturnValue(initial + 9_000);
    const pong = new Promise<void>((resolve) =>
      fixture.socket.once("pong", () => resolve()),
    );
    fixture.socket.ping();
    await pong;
    const closed = onClose(fixture.socket);
    monotonic.mockReturnValue(initial + 11_000);
    checkConnections();
    expect((await closed).code).toBe(1008);
  });

  it("uses WebSocket pings for bidirectional liveness", async () => {
    const fixture = await gatewayFixture();
    const ping = new Promise<void>((resolve) =>
      fixture.socket.once("ping", () => resolve()),
    );
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 16_000);
    checkConnections();
    await ping;
    expect(hub!.isOnline(fixture.instanceId)).toBe(true);
  });

  it("times out requests and removes their abort listeners", async () => {
    const fixture = await gatewayFixture();
    const controller = new AbortController();
    await expect(
      hub!.relay(
        fixture.instanceId,
        { type: "getProductSnapshot" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
    const { getEventListeners } = await import("node:events");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("truncates Unicode close reasons by bytes without breaking the close handshake", async () => {
    const fixture = await gatewayFixture();
    const closed = onClose(fixture.socket);
    hub!.disconnect(fixture.instanceId, "😀".repeat(100));
    const result = await closed;
    expect(result.code).toBe(1008);
    expect(result.reason.toString()).toBe("😀".repeat(30));
  });
});

function checkConnections(): void {
  (hub as unknown as { checkConnections(): void }).checkConnections();
}

function onClose(socket: WebSocket): Promise<{ code: number; reason: Buffer }> {
  return new Promise((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason })),
  );
}

function nextMessage(socket: WebSocket): Promise<ManagerMessage> {
  return new Promise((resolve) =>
    socket.once("message", (data) =>
      resolve(JSON.parse(data.toString()) as ManagerMessage),
    ),
  );
}

async function gatewayFixture(hello = true, runs = false) {
  database = new FleetDatabase(":memory:");
  const store = new FleetStore(database);
  hub = new GatewayHub(testConfig(), store);
  const enrollmentKey = createSecret("mch_enroll");
  const instanceSecret = createSecret("mch_instance");
  store.createEnrollmentGrant(
    enrollmentKey,
    nowSeconds(),
    testConfig().enrollmentPolicy,
  );
  const { instanceId } = store.enrollInstance(
    {
      enrollmentKey,
      instanceSecret,
      displayName: "Test",
      productVersion: "7.0.6",
      protocolVersion: gatewayProtocolVersion,
    },
    nowSeconds(),
  );
  const server = createServer();
  servers.push(server);
  server.on("upgrade", (request, socket, head) =>
    hub!.handleUpgrade(request, socket, head),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Invalid test server address.");
  const connect = async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/gateway/connect/${instanceId}`,
      { headers: { Authorization: `Bearer ${instanceSecret}` } },
    );
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    if (hello) {
      socket.send(
        JSON.stringify({
          type: "hello",
          instanceId,
          protocolVersion: gatewayProtocolVersion,
          productVersion: "7.0.6",
          capabilities: [
            productCapability,
            ...(runs ? ["workspace-runs.v1"] : []),
          ],
        }),
      );
      await waitUntil(() => hub!.isOnline(instanceId));
    }
    return socket;
  };
  const socket = await connect();
  const webSocketServer = (hub as unknown as { server: WebSocketServer })
    .server;
  const serverSocket = [...webSocketServer.clients][0]!;
  return { socket, serverSocket, connect, instanceId, store };
}

describe("outbound gateway relay", () => {
  it("authenticates an enrolled client and correlates remote responses", async () => {
    const config = testConfig();
    database = new FleetDatabase(":memory:");
    const store = new FleetStore(database);
    const updatePresence = vi.spyOn(store, "updateInstancePresence");
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
    await expect(
      rawUpgrade(address.port, "/api/gateway/connect/%"),
    ).resolves.toMatch(/^HTTP\/1\.1 400 Bad Request/mu);
    await expect(
      rawUpgrade(
        address.port,
        `/api/gateway/connect/${instance.instanceId}`,
        `Authorization: Bearer ${instanceSecret}\r\nSec-WebSocket-Key: invalid\r\nSec-WebSocket-Version: 13\r\n`,
      ),
    ).resolves.toMatch(/^HTTP\/1\.1 400 Bad Request/mu);
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
    for (let index = 0; index < 260; index += 1) {
      socket.send(JSON.stringify({ type: "heartbeat", sentAt: nowSeconds() }));
    }
    const closeCode = await new Promise<number>((resolve) => {
      socket.once("close", resolve);
    });
    expect(closeCode).toBe(1008);
    expect(updatePresence).toHaveBeenCalledTimes(1);
    await waitUntil(() => hub?.isOnline(instance.instanceId) === false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

async function rawUpgrade(
  port: number,
  path: string,
  extraHeaders = "",
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${extraHeaders}\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

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
        maximumPromptsPerProfile: 128,
        maximumRevisionsPerProfile: 100,
        maximumDocumentBytes: 1024 * 1024,
        maximumSecretBytes: 8192,
      },
    },
  };
}
