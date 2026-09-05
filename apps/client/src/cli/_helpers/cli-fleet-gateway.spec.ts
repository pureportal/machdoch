import { once } from "node:events";
import { createServer } from "node:http";
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
  it.each([409, 503, 401, 403, 404])(
    "classifies HTTP %s for supervision",
    async (status) => {
      const server = createServer((_request, response) => {
        response.writeHead(status);
        response.end();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server port");
      try {
        expect(
          await runFleetGatewayConnection({
            config: config(`http://127.0.0.1:${address.port}`),
            signal: new AbortController().signal,
            productVersion: "test",
            handleRequest: vi.fn(),
          }),
        ).toMatchObject({ reconnect: status === 409 || status === 503 });
        if (status === 401) {
          await expect(
            runFleetGatewayService({
              signal: new AbortController().signal,
              productVersion: "test",
              handleRequest: vi.fn(),
              loadConfig: async () =>
                config(`http://127.0.0.1:${address.port}`),
            }),
          ).rejects.toMatchObject({ exitCode: 78 });
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("bounds unfinished requests and ignores completions after disconnect", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server port");
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handleRequest = vi.fn(async () => {
      await pending;
      return {
        type: "error" as const,
        code: "unavailable" as const,
        message: "finished",
      };
    });
    const messages: Array<{
      type: string;
      requestId?: string;
      response?: { message: string };
    }> = [];
    const busy = new Promise<void>((resolve) => {
      server.on("connection", (socket) =>
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString());
          messages.push(message);
          if (message.type === "hello")
            for (let i = 0; i < 10; i++)
              socket.send(
                JSON.stringify({
                  type: "request",
                  requestId: `bounded-${i}`,
                  request: { type: "getProductSnapshot" },
                }),
              );
          if (message.response?.message?.includes("busy")) resolve();
        }),
      );
    });
    const connection = runFleetGatewayConnection({
      config: config(`http://127.0.0.1:${address.port}`),
      signal: controller.signal,
      productVersion: "test",
      handleRequest,
    });
    try {
      await busy;
      expect(handleRequest).toHaveBeenCalledTimes(8);
      controller.abort();
      await connection;
      release?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        messages.some((message) => message.response?.message === "finished"),
      ).toBe(false);
    } finally {
      controller.abort();
      release?.();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("catches a synchronous request handler failure without crashing", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server port");
    const controller = new AbortController();
    const response = new Promise<unknown>((resolve) => {
      server.once("connection", (socket) =>
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === "hello")
            socket.send(
              JSON.stringify({
                type: "request",
                requestId: "throws",
                request: { type: "getProductSnapshot" },
              }),
            );
          if (message.type === "response") resolve(message.response);
        }),
      );
    });
    const connection = runFleetGatewayConnection({
      config: config(`http://127.0.0.1:${address.port}`),
      signal: controller.signal,
      productVersion: "test",
      handleRequest: () => {
        throw new Error("handler failed");
      },
    });
    try {
      expect(await response).toMatchObject({
        type: "error",
        message: "handler failed",
      });
    } finally {
      controller.abort();
      await connection;
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("backs off across flapping connections and stops promptly during backoff", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server port");
    server.on("connection", (socket) =>
      socket.once("message", () => socket.close(1012, "restarting")),
    );
    const controller = new AbortController();
    const retries: string[] = [];
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const loadConfig = vi.fn(async () =>
      config(`http://127.0.0.1:${address.port}`),
    );
    try {
      expect(
        await runFleetGatewayService({
          signal: controller.signal,
          productVersion: "test",
          handleRequest: vi.fn(),
          loadConfig,
          reconnectDelaysMs: [1, 2000],
          configPollIntervalMs: 60_000,
          onStatus: (event) => {
            if (event.phase === "reconnecting") {
              retries.push(event.message ?? "");
              if (retries.length === 2) controller.abort();
            }
          },
        }),
      ).toEqual({ reason: "stopped" });
      expect(retries[1]).toContain("2 seconds");
      expect(loadConfig).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
      controller.abort();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
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
          capabilities: [productCapability, "workspace-runs.v1"],
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
