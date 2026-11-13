import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetConnectionConfig } from "../../core/fleet-connection.ts";
import { runFleetGatewayService } from "./cli-fleet-gateway.ts";

const config = (port: number): FleetConnectionConfig => ({
  schemaVersion: 1,
  enabled: true,
  managerUrl: `http://127.0.0.1:${port}`,
  managerId: "manager-test",
  instanceId: "instance-test",
  displayName: "CLI host",
  instanceSecret: "instance-secret",
});

let originalEntryPoint: string | undefined;
const controllers: AbortController[] = [];
const servers: Server[] = [];
const gateways: WebSocketServer[] = [];

beforeEach(() => {
  originalEntryPoint = process.argv[1];
  process.argv[1] = "src/cli/main.ts";
});

afterEach(async () => {
  controllers.splice(0).forEach((controller) => controller.abort());
  vi.useRealTimers();
  for (const gateway of gateways.splice(0)) {
    for (const client of gateway.clients) client.terminate();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  vi.restoreAllMocks();
  if (originalEntryPoint === undefined) process.argv.splice(1, 1);
  else process.argv[1] = originalEntryPoint;
});

describe("Fleet gateway reconnection", () => {
  it("keeps retrying temporary upgrade failures and exchanges requests after recovery", async () => {
    const failures = [403, 404, 409, 429, 500, 502, 503, 504];
    const server = createServer();
    servers.push(server);
    const gateway = new WebSocketServer({ noServer: true });
    gateways.push(gateway);
    let attempts = 0;
    const controller = new AbortController();
    controllers.push(controller);
    const responses: unknown[] = [];
    server.on("upgrade", (request, socket, head) => {
      const status = failures[attempts++];
      if (status !== undefined) {
        socket.end(
          `HTTP/1.1 ${status} Temporary failure\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      gateway.handleUpgrade(request, socket, head, (client) => {
        client.on("message", (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === "hello")
            client.send(
              JSON.stringify({
                type: "request",
                requestId: "recovered-request",
                request: { type: "getProductSnapshot" },
              }),
            );
          if (message.type === "response") {
            responses.push(message);
            controller.abort();
          }
        });
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server port.");
    const statuses: string[] = [];
    const handleRequest = vi.fn(async () => ({
      type: "error" as const,
      code: "unavailable" as const,
      message: "Recovered connection.",
    }));

    await expect(
      runFleetGatewayService({
        signal: controller.signal,
        productVersion: "test",
        handleRequest,
        loadConfig: async () => config(address.port),
        reconnectDelaysMs: [1, 1],
        onStatus: (event) => statuses.push(event.phase),
      }),
    ).resolves.toEqual({ reason: "stopped" });

    expect(attempts).toBe(failures.length + 1);
    expect(statuses.filter((phase) => phase === "reconnecting")).toHaveLength(
      failures.length,
    );
    expect(handleRequest).toHaveBeenCalledExactlyOnceWith({
      type: "getProductSnapshot",
    });
    expect(responses).toEqual([
      {
        type: "response",
        requestId: "recovered-request",
        response: {
          type: "error",
          code: "unavailable",
          message: "Recovered connection.",
        },
      },
    ]);
  });

  it.each([1001, 1012, 1013])(
    "reconnects automatically after temporary close code %s",
    async (code) => {
      const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      gateways.push(gateway);
      await once(gateway, "listening");
      const address = gateway.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server port.");
      let connections = 0;
      const controller = new AbortController();
      controllers.push(controller);
      gateway.on("connection", (client) => {
        connections += 1;
        client.once("message", () => {
          if (connections === 1) client.close(code, "Temporary failure.");
          else controller.abort();
        });
      });

      await expect(
        runFleetGatewayService({
          signal: controller.signal,
          productVersion: "test",
          handleRequest: vi.fn(),
          loadConfig: async () => config(address.port),
          reconnectDelaysMs: [1],
        }),
      ).resolves.toEqual({ reason: "stopped" });
      expect(connections).toBe(2);
    },
  );

  it("reconnects a half-open connection when the cloud stops responding", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const gateway = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      autoPong: false,
    });
    gateways.push(gateway);
    await once(gateway, "listening");
    const address = gateway.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server port.");
    const controller = new AbortController();
    controllers.push(controller);
    const statuses: string[] = [];
    let connected: () => void;
    const firstConnection = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const service = runFleetGatewayService({
      signal: controller.signal,
      productVersion: "test",
      handleRequest: vi.fn(),
      loadConfig: async () => config(address.port),
      reconnectDelaysMs: [1],
      onStatus: (event) => {
        statuses.push(event.phase);
        if (event.phase !== "connected") return;
        if (statuses.filter((phase) => phase === "connected").length === 1)
          connected();
        else controller.abort();
      },
    });

    await firstConnection;
    clock.mockReturnValue(60_001);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(service).resolves.toEqual({ reason: "stopped" });
    expect(statuses.filter((phase) => phase === "connected")).toHaveLength(2);
    expect(statuses).toContain("reconnecting");
  });

  it.each([1002, 1003, 1007, 1008, 1009, 1010])(
    "does not retry permanent close code %s",
    async (code) => {
      const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      gateways.push(gateway);
      await once(gateway, "listening");
      const address = gateway.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server port.");
      gateway.on("connection", (client) =>
        client.once("message", () =>
          client.close(code, "Connection rejected."),
        ),
      );
      const controller = new AbortController();
      controllers.push(controller);

      await expect(
        runFleetGatewayService({
          signal: controller.signal,
          productVersion: "test",
          handleRequest: vi.fn(),
          loadConfig: async () => config(address.port),
          reconnectDelaysMs: [1],
        }),
      ).rejects.toMatchObject({ exitCode: 78 });
    },
  );
});
