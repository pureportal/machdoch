import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createLocalMcpServer } from "./server.js";
import {
  createLocalToolRuntime,
  type LocalToolRuntimeOptions,
} from "./runtime.js";

export interface LocalMcpEndpoint {
  url: string;
  token: string;
}

export const startLocalMcpHost = async (
  options: LocalToolRuntimeOptions,
): Promise<{
  endpoint: LocalMcpEndpoint;
  close: () => Promise<void>;
}> => {
  const lifetime = new AbortController();
  const runtime = createLocalToolRuntime({
    ...options,
    signal: AbortSignal.any([
      lifetime.signal,
      ...(options.signal ? [options.signal] : []),
    ]),
  });
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const connections = new Set<Server>();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (
      supplied.length !== authorization.length ||
      !timingSafeEqual(supplied, authorization)
    ) {
      response.writeHead(401).end();
      return;
    }
    if (
      request.headers.origin ||
      request.headers.host !== new URL(endpoint.url).host
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const sessionId = request.headers["mcp-session-id"];
    if (sessionId !== undefined) {
      const transport =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!transport) {
        response.writeHead(404).end();
        return;
      }
      void transport.handleRequest(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      return;
    }
    const server = createLocalMcpServer(runtime);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    connections.add(server);
    server.onclose = () => {
      connections.delete(server);
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    response.once("finish", () => {
      if (!transport.sessionId) void server.close();
    });
    void server
      .connect(transport as unknown as Transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Machdoch MCP could not bind a loopback port.");
  const endpoint = { url: `http://127.0.0.1:${address.port}/mcp`, token };
  return {
    endpoint,
    async close() {
      lifetime.abort();
      await Promise.all([...connections].map((server) => server.close()));
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      });
      await runtime.waitForIdle();
    },
  };
};
