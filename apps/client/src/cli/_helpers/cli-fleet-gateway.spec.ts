import { once } from "node:events";
import { productCapability } from "@machdoch/fleet-protocol";
import { WebSocketServer } from "ws";
import type { FleetConnectionConfig } from "../../core/fleet-connection.ts";
import {
  createFleetGatewayUrl,
  runFleetGatewayConnection,
  runFleetGatewayService,
} from "./cli-fleet-gateway.ts";

const config = (managerUrl: string): FleetConnectionConfig => ({
  schemaVersion: 1,
  enabled: true,
  managerUrl,
  managerId: "manager-test",
  instanceId: "instance-test",
  displayName: "CLI host",
  instanceSecret: "instance-secret",
});

let originalEntryPoint: string | undefined;

beforeEach(() => {
  originalEntryPoint = process.argv[1];
  process.argv[1] = "src/cli/main.ts";
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalEntryPoint === undefined) process.argv.splice(1, 1);
  else process.argv[1] = originalEntryPoint;
});

describe("Fleet CLI gateway", () => {
  it("derives the authenticated gateway route from the manager origin", () => {
    expect(
      createFleetGatewayUrl({
        managerUrl: "https://fleet.example.test",
        instanceId: "instance/one",
      }),
    ).toBe("wss://fleet.example.test/api/gateway/connect/instance%2Fone");
  });

  it("exchanges protocol messages without a desktop UI", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("Fleet test server did not expose a TCP port.");
    }
    const controller = new AbortController();
    let authorization = "";
    const received: unknown[] = [];
    const responseReceived = new Promise<void>((resolve, reject) => {
      server.once("connection", (socket, request) => {
        authorization = request.headers.authorization ?? "";
        socket.on("message", (payload) => {
          const message = JSON.parse(payload.toString()) as { type?: string };
          received.push(message);
          if (message.type === "hello") {
            socket.send(
              JSON.stringify({
                type: "request",
                requestId: "request-1",
                request: { type: "getProductSnapshot" },
              }),
            );
          } else if (message.type === "response") {
            resolve();
          }
        });
        socket.on("error", reject);
      });
    });

    const connection = runFleetGatewayConnection({
      config: config(`http://127.0.0.1:${address.port}`),
      signal: controller.signal,
      productVersion: "6.3.0",
      handleRequest: async () => ({
        type: "error",
        code: "unavailable",
        message: "Test response",
      }),
    });
    await responseReceived;
    controller.abort();
    await expect(connection).resolves.toMatchObject({ reconnect: false });
    expect(authorization).toBe("Bearer instance-secret");
    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "hello",
          protocolVersion: 4,
          productVersion: "6.3.0",
          capabilities: [productCapability],
        }),
        expect.objectContaining({ type: "response", requestId: "request-1" }),
      ]),
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not connect while disabled and stops after configuration is disabled", async () => {
    const statuses: string[] = [];
    await expect(
      runFleetGatewayService({
        signal: new AbortController().signal,
        productVersion: "6.3.0",
        handleRequest: vi.fn(),
        loadConfig: async () => null,
        onStatus: (event) => statuses.push(event.phase),
      }),
    ).resolves.toEqual({ reason: "disabled" });
    expect(statuses).toEqual(["disabled"]);

    let loads = 0;
    statuses.length = 0;
    await expect(
      runFleetGatewayService({
        signal: new AbortController().signal,
        productVersion: "6.3.0",
        handleRequest: vi.fn(),
        loadConfig: async () => {
          loads += 1;
          return loads === 1 ? config("http://127.0.0.1:1") : null;
        },
        reconnectDelaysMs: [1],
        configPollIntervalMs: 1,
        onStatus: (event) => statuses.push(event.phase),
      }),
    ).resolves.toEqual({ reason: "disabled" });
    expect(statuses).toContain("connecting");
    expect(statuses.at(-1)).toBe("disabled");
  });
});
