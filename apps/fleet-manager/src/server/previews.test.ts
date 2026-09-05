import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { connect, type Socket } from "node:net";
import { pipeline, Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer, createWebSocketStream } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostRequest,
  HostResponse,
  RunSnapshot,
} from "@machdoch/fleet-protocol";
import { FleetPreviewHub, previewHeaders } from "./previews";
import type { FleetRuntime } from "./runtime";

const servers: Server[] = [];
const sockets = new Set<Socket>();
const webSockets = new Set<WebSocket>();
let hub: FleetPreviewHub | undefined;
afterEach(async () => {
  hub?.close();
  hub = undefined;
  for (const ws of webSockets) ws.terminate();
  webSockets.clear();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as { port: number }).port;
}
function http(
  port: number,
  host: string,
  path: string,
  options: {
    method?: string;
    headers?: IncomingHttpHeaders;
    body?: string | Buffer;
  } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((done, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { host, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () =>
          done({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.once("error", reject);
      },
    );
    req.once("error", reject);
    req.end(options.body);
  });
}
async function fixture() {
  let upstreamHeaders: IncomingHttpHeaders = {};
  const binary = Buffer.alloc(2 * 1024 * 1024, 0xb3);
  const app = createServer((req, res) => {
    upstreamHeaders = req.headers;
    if (req.url === "/binary") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": binary.length,
      });
      res.end(binary);
    } else if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: hello\n\n");
    } else if (req.url === "/cookies") {
      res.writeHead(200, {
        "Set-Cookie": [
          "__Host-machdoch_preview=attacker; Path=/; Secure",
          "app=value; Domain=example.test; Path=/",
          "__Host-machdoch_fleet_session=evil; Path=/; Secure",
        ],
        Connection: "close, x-hop",
        "X-Hop": "secret",
      });
      res.end("cookies");
    } else if (req.url === "/redirect") {
      res.writeHead(302, {
        Location: `http://localhost:${appPort}/destination`,
      });
      res.end();
    } else if (req.method === "POST") {
      req.pipe(res);
    } else res.end(req.url);
  });
  const appPort = await listen(app);
  const wsApp = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  app.on("upgrade", (req, socket, head) =>
    wsApp.handleUpgrade(req, socket, head, (ws) => {
      webSockets.add(ws);
      ws.on("message", (value, binary) => ws.send(value, { binary }));
    }),
  );
  const apiServer = createServer((req, res) => res.end(`backend:${req.url}`));
  const apiPort = await listen(apiServer);
  let loggedIn = true;
  let generation: string | null = "generation-1";
  let managerPort = 0;
  const snapshot = {
    workspace: "/project",
    document: {
      configurations: [
        { id: "web", kind: "task", ports: [appPort] },
        { id: "api", kind: "task", ports: [apiPort] },
      ],
    },
    statuses: [
      { id: "web", pid: 10, state: "running" },
      { id: "api", pid: 11, state: "running" },
    ],
  } as RunSnapshot;
  const relay = vi.fn(
    async (_id: string, input: HostRequest): Promise<HostResponse> => {
      if (input.type === "getWorkspaceRuns")
        return { type: "workspaceRuns", snapshot };
      if (input.type !== "openPreviewTunnel")
        throw new Error("Unexpected request");
      const ws = new WebSocket(
        `ws://127.0.0.1:${managerPort}/api/gateway/preview/${input.tunnelId}`,
        {
          headers: { Authorization: `Bearer ${input.token}` },
          perMessageDeflate: false,
        },
      );
      webSockets.add(ws);
      const local = connect({ host: "127.0.0.1", port: input.target.port });
      sockets.add(local);
      local.once("close", () => sockets.delete(local));
      await new Promise<void>((done, reject) => {
        ws.once("open", done);
        ws.once("error", reject);
      });
      const stream = createWebSocketStream(ws, { highWaterMark: 65536 });
      pipeline(stream, local, stream, () => {
        ws.terminate();
        local.destroy();
      });
      return { type: "previewTunnelReady" };
    },
  );
  const runtime = {
    config: {
      externalBaseUrl: "https://fleet.example.test",
      previews: { baseUrl: "https://previews.example.test" },
    },
    gateways: { generation: () => generation, supportsRuns: () => true, relay },
    authStore: { isSessionActive: () => loggedIn },
    database: { audit: vi.fn() },
  } as unknown as FleetRuntime;
  hub = new FleetPreviewHub(runtime);
  const manager = createServer((req, res) => {
    void hub!.handleHttp(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  manager.on("upgrade", (req, socket, head) => {
    if (!hub!.handleUpgrade(req, socket, head)) socket.destroy();
  });
  managerPort = await listen(manager);
  const grant = await hub.create(
    "instance",
    { username: "owner", sessionId: "session", sessionHash: "hash" },
    {
      target: { workspace: "/project", configurationId: "web", port: appPort },
      routes: [
        {
          prefix: "/api",
          configurationId: "api",
          port: apiPort,
          stripPrefix: true,
        },
      ],
    },
    new AbortController().signal,
  );
  const origin = new URL(grant.action).origin;
  const host = new URL(grant.action).host;
  const launch = await http(managerPort, host, "/.machdoch/launch", {
    method: "POST",
    headers: {
      origin: runtime.config.externalBaseUrl,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `ticket=${grant.ticket}`,
  });
  const cookie = launch.headers["set-cookie"]?.[0]?.split(";")[0] ?? "";
  return {
    managerPort,
    host,
    origin,
    cookie,
    launch,
    grant,
    appPort,
    apiPort,
    binary,
    relay,
    getHeaders: () => upstreamHeaders,
    logout: () => {
      loggedIn = false;
    },
    disconnect: () => {
      generation = null;
    },
  };
}

describe("private preview relay", () => {
  it("fails promptly when the host rejects a tunnel and cleans pending slots", async () => {
    const f = await fixture();
    f.relay.mockImplementation(async (_id, request) => {
      if (request.type !== "openPreviewTunnel")
        throw new Error("Unexpected request");
      return {
        type: "error",
        code: "unavailable",
        message: "Service is starting. Try again shortly.",
      };
    });
    const started = Date.now();
    const result = await http(f.managerPort, f.host, "/", {
      headers: { cookie: f.cookie },
    });
    expect(result.status).toBe(502);
    expect(result.body.toString()).toContain("starting");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hub!.list("instance")[0]?.connections).toBe(0);
  });
  it("handles reset errors on rejected preview sockets", async () => {
    await fixture();
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    expect(
      hub!.handleUpgrade(
        {
          url: "/api/gateway/preview/11111111-1111-1111-1111-111111111111",
          headers: {},
        } as IncomingMessage,
        socket,
        Buffer.alloc(0),
      ),
    ).toBe(true);
    expect(() => socket.emit("error", new Error("reset"))).not.toThrow();
    expect(socket.destroyed).toBe(true);
  });
  it("launches with a one-use POST ticket and strips private cookies in both directions", async () => {
    const f = await fixture();
    expect(f.launch.status).toBe(303);
    expect(f.launch.headers["set-cookie"]?.[0]).toContain(
      "HttpOnly; Secure; SameSite=Lax",
    );
    const replay = await http(f.managerPort, f.host, "/.machdoch/launch", {
      method: "POST",
      headers: {
        origin: "https://fleet.example.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `ticket=${f.grant.ticket}`,
    });
    expect(replay.status).toBe(403);
    const res = await http(f.managerPort, f.host, "/cookies", {
      headers: {
        cookie: `${f.cookie}; app=hello; __Host-machdoch_fleet_session=private`,
        "x-forwarded-for": "forged",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toEqual(["app=value; Path=/"]);
    expect(res.headers["x-hop"]).toBeUndefined();
    expect(f.getHeaders().cookie).toBe("app=hello");
    expect(f.getHeaders()["x-forwarded-for"]).toBeUndefined();
  });
  it("streams binary downloads and uploads and routes the backend under the same origin", async () => {
    const f = await fixture();
    const headers = { cookie: f.cookie, origin: f.origin };
    expect(
      (await http(f.managerPort, f.host, "/binary", { headers })).body.equals(
        f.binary,
      ),
    ).toBe(true);
    expect(
      (
        await http(f.managerPort, f.host, "/upload", {
          method: "POST",
          headers,
          body: f.binary,
        })
      ).body.equals(f.binary),
    ).toBe(true);
    expect(
      (
        await http(f.managerPort, f.host, "/api/items?limit=2", { headers })
      ).body.toString(),
    ).toBe("backend:/items?limit=2");
    expect(
      (
        await http(f.managerPort, f.host, "/api?limit=2", { headers })
      ).body.toString(),
    ).toBe("backend:/?limit=2");
    expect(
      (
        await http(f.managerPort, f.host, "/api-other", { headers })
      ).body.toString(),
    ).toBe("/api-other");
    expect(
      (await http(f.managerPort, f.host, "/redirect", { headers })).headers
        .location,
    ).toBe(`${f.origin}/destination`);
  });
  it("delivers SSE incrementally and releases the tunnel when the browser leaves", async () => {
    const f = await fixture();
    const first = await new Promise<string>((done, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: f.managerPort,
          path: "/events",
          headers: { host: f.host, cookie: f.cookie },
        },
        (res) => {
          res.once("data", (chunk: Buffer) => {
            done(chunk.toString());
            req.destroy();
          });
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(first).toBe("data: hello\n\n");
    await vi.waitFor(() =>
      expect(hub!.list("instance")[0]?.connections).toBe(0),
    );
  });
  it("preserves WebSocket frames and subprotocols, then closes them on logout", async () => {
    const f = await fixture();
    const ws = new WebSocket(
      `ws://127.0.0.1:${f.managerPort}/socket`,
      ["test-protocol"],
      { headers: { host: f.host, cookie: f.cookie, origin: f.origin } },
    );
    webSockets.add(ws);
    await new Promise<void>((done, reject) => {
      ws.once("open", done);
      ws.once("error", reject);
    });
    expect(ws.protocol).toBe("test-protocol");
    const message = new Promise<string>((done) =>
      ws.once("message", (value) => done(value.toString())),
    );
    ws.send("hot reload");
    expect(await message).toBe("hot reload");
    const closed = new Promise<void>((done) => ws.once("close", () => done()));
    f.logout();
    await closed;
    expect(hub!.list("instance")).toEqual([]);
  });
  it("blocks unauthenticated access, foreign origins, arbitrary ports, and disconnected grants", async () => {
    const f = await fixture();
    expect((await http(f.managerPort, f.host, "/")).status).toBe(401);
    expect(
      (
        await http(f.managerPort, f.host, "/", {
          headers: { cookie: f.cookie, origin: "https://evil.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await http(f.managerPort, f.host, "/", {
          headers: {
            cookie: f.cookie,
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "no-cors",
          },
        })
      ).status,
    ).toBe(403);
    await expect(
      hub!.create(
        "instance",
        { username: "owner", sessionId: "session", sessionHash: "hash" },
        {
          target: { workspace: "/project", configurationId: "web", port: 2375 },
          routes: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Start each selected service");
    f.disconnect();
    expect(
      (
        await http(f.managerPort, f.host, "/", {
          headers: { cookie: f.cookie },
        })
      ).status,
    ).toBe(410);
  });
  it("removes Connection-nominated hop headers", () => {
    expect(
      previewHeaders({
        connection: "X-Secret, keep-alive",
        "x-secret": "value",
        "keep-alive": "timeout=5",
        authorization: "Bearer app",
      }),
    ).toEqual({ authorization: "Bearer app" });
  });
});
