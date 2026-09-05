import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { pipeline, type Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream, type WebSocket } from "ws";
import {
  previewTargetSchema,
  type PreviewTarget,
} from "@machdoch/fleet-protocol";
import { z } from "zod";
import type { AuthenticatedSession } from "./auth-store";
import { nowSeconds } from "./database";
import { HttpError } from "./errors";
import { rejectUpgrade } from "./gateway";
import type { FleetRuntime } from "./runtime";

export const previewOpenSchema = z
  .strictObject({
    target: previewTargetSchema,
    routes: z
      .array(
        z.strictObject({
          prefix: z
            .string()
            .regex(/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/)
            .max(120)
            .refine((v) => !v.startsWith("/.machdoch")),
          configurationId: previewTargetSchema.shape.configurationId,
          port: previewTargetSchema.shape.port,
          stripPrefix: z.boolean(),
        }),
      )
      .max(8)
      .default([]),
  })
  .refine(
    (v) => new Set(v.routes.map((r) => r.prefix)).size === v.routes.length,
    "Route prefixes must be unique.",
  );
type PreviewOpen = z.infer<typeof previewOpenSchema>;
const cookieName = "__Host-machdoch_preview";
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const secret = (): string => randomBytes(32).toString("hex");
interface Grant {
  id: string;
  origin: string;
  instanceId: string;
  generation: string;
  sessionHash: string;
  target: PreviewTarget;
  routes: PreviewOpen["routes"];
  expiresAt: number;
  ticketHash: string | null;
  ticketExpiresAt: number;
  cookieHash: string | null;
  connections: Set<() => void>;
}
interface PendingTunnel {
  tokenHash: string;
  grant: Grant;
  resolve: (stream: Duplex) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function previewHeaders(
  input: IncomingHttpHeaders,
  response = false,
): IncomingHttpHeaders {
  const blocked = new Set([
    ...hopByHop,
    ...(input.connection ?? "").split(",").map((v) => v.trim().toLowerCase()),
    "forwarded",
    "x-forwarded-host",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-real-ip",
    "x-machdoch-fleet-csrf",
  ]);
  const output: IncomingHttpHeaders = Object.create(null);
  for (const [key, value] of Object.entries(input))
    if (!blocked.has(key) && !key.startsWith("x-forwarded-"))
      output[key] = value;
  if (!response && typeof output.cookie === "string") {
    output.cookie = output.cookie
      .split(";")
      .filter((part) => !/^\s*__Host-machdoch_/i.test(part))
      .join(";");
    if (!output.cookie) delete output.cookie;
  }
  if (response) {
    if (output["set-cookie"])
      output["set-cookie"] = output["set-cookie"]
        .filter((v) => !/^\s*__Host-machdoch_/i.test(v))
        .map((v) => v.replace(/;\s*domain\s*=[^;]*/gi, ""));
    delete output["alt-svc"];
    delete output["clear-site-data"];
  }
  return output;
}

export function getPreviewHub(runtime: FleetRuntime): FleetPreviewHub {
  return (runtime.previews ??= new FleetPreviewHub(runtime));
}

export class FleetPreviewHub {
  private readonly grants = new Map<string, Grant>();
  private readonly pending = new Map<string, PendingTunnel>();
  private readonly server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });
  private readonly sockets = new Set<WebSocket>();
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  constructor(private readonly runtime: FleetRuntime) {
    this.timer = setInterval(() => {
      for (const grant of this.grants.values())
        if (!this.valid(grant)) this.revoke(grant);
    }, 1000);
    this.timer.unref();
  }
  get enabled(): boolean {
    return Boolean(this.runtime.config.previews);
  }
  list(instanceId: string): Array<{
    id: string;
    origin: string;
    configurationId: string;
    port: number;
    expiresAt: number;
    connections: number;
  }> {
    return [...this.grants.values()]
      .filter((g) => g.instanceId === instanceId && this.valid(g))
      .map((g) => ({
        id: g.id,
        origin: g.origin,
        configurationId: g.target.configurationId,
        port: g.target.port,
        expiresAt: g.expiresAt,
        connections: g.connections.size,
      }));
  }
  async create(
    instanceId: string,
    session: AuthenticatedSession,
    input: PreviewOpen,
    signal: AbortSignal,
  ): Promise<{
    id: string;
    action: string;
    ticket: string;
    expiresAt: number;
  }> {
    if (!this.enabled || this.closed)
      throw new HttpError(
        503,
        "Private previews are not configured. Set previews.baseUrl and wildcard HTTPS routing on Fleet Manager.",
      );
    if (this.grants.size >= 64)
      throw new HttpError(
        429,
        "Close an existing preview before opening another.",
      );
    const generation = this.runtime.gateways.generation(instanceId);
    if (!generation || !this.runtime.gateways.supportsRuns(instanceId))
      throw new HttpError(
        503,
        "This host needs a connected headless Fleet service with preview support.",
      );
    const result = await this.runtime.gateways.relay(
      instanceId,
      { type: "getWorkspaceRuns", workspace: input.target.workspace },
      signal,
    );
    if (result.type === "error") throw new HttpError(409, result.message);
    if (result.type !== "workspaceRuns")
      throw new HttpError(502, "Invalid service status.");
    for (const target of [input.target, ...input.routes]) {
      const config = result.snapshot.document.configurations.find(
        (c) => c.id === target.configurationId,
      );
      const status = result.snapshot.statuses.find(
        (s) => s.id === target.configurationId,
      );
      if (
        config?.kind !== "task" ||
        !config.ports.includes(target.port) ||
        !status?.pid ||
        !["running", "unhealthy"].includes(status.state)
      )
        throw new HttpError(
          409,
          "Start each selected service before opening its preview.",
        );
    }
    if (
      signal.aborted ||
      this.grants.size >= 64 ||
      generation !== this.runtime.gateways.generation(instanceId) ||
      !this.runtime.authStore.isSessionActive(session.sessionHash, nowSeconds())
    )
      throw new HttpError(409, "Preview authorization changed. Try again.");
    const id = randomBytes(12).toString("hex");
    const origin = new URL(this.runtime.config.previews!.baseUrl);
    origin.hostname = `p-${id}.${origin.hostname}`;
    const ticket = secret();
    const grant: Grant = {
      id,
      origin: origin.origin,
      instanceId,
      generation,
      sessionHash: session.sessionHash,
      target: input.target,
      routes: input.routes.toSorted(
        (a, b) => b.prefix.length - a.prefix.length,
      ),
      expiresAt: Date.now() + 3600000,
      ticketHash: hash(ticket),
      ticketExpiresAt: Date.now() + 60000,
      cookieHash: null,
      connections: new Set(),
    };
    this.grants.set(id, grant);
    this.runtime.database.audit(
      nowSeconds(),
      "preview.opened",
      instanceId,
      "success",
    );
    return {
      id,
      action: `${origin.origin}/.machdoch/launch`,
      ticket,
      expiresAt: grant.expiresAt,
    };
  }
  launchPage(id: string, sessionHash: string, instanceId: string): Response {
    const grant = this.grants.get(id);
    if (
      !grant ||
      grant.sessionHash !== sessionHash ||
      grant.instanceId !== instanceId ||
      !this.valid(grant) ||
      !grant.ticketHash
    )
      throw new HttpError(
        410,
        "Preview launch expired. Open it again from Fleet Manager.",
      );
    const nonce = secret();
    // The fragment never reaches access logs. Remove it before leaving the manager.
    // A dedicated page keeps the main application's form-action restricted to self.
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening private preview</title><p>Opening private preview…</p><form method="post" action="${grant.origin}/.machdoch/launch"><input type="hidden" name="ticket"><button type="submit">Continue to preview</button></form><script nonce="${nonce}">const ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(/^[a-f0-9]{64}$/.test(ticket)){document.querySelector('input').value=ticket;document.forms[0].submit();}else{document.querySelector('p').textContent='Launch expired. Open a new preview from Fleet Manager.';document.querySelector('form').remove();}</script>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "strict-origin",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${grant.origin}; base-uri 'none'; frame-ancestors 'none'`,
        },
      },
    );
  }
  revokeInstance(instanceId: string, id?: string): void {
    for (const grant of this.grants.values())
      if (grant.instanceId === instanceId && (!id || grant.id === id))
        this.revoke(grant);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const grant of this.grants.values()) this.revoke(grant);
    for (const ws of this.sockets) ws.terminate();
    this.server.close();
  }
  matchesHost(request: IncomingMessage): boolean {
    const base = this.runtime.config.previews;
    if (!base) return false;
    const host = this.host(request);
    const url = new URL(base.baseUrl);
    return host.endsWith(`.${url.host.toLowerCase()}`);
  }
  async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (!this.matchesHost(request)) return false;
    try {
      const grant = this.requestGrant(request);
      if (request.url === "/.machdoch/launch") {
        if (
          request.method !== "POST" ||
          request.headers.origin !==
            new URL(this.runtime.config.externalBaseUrl).origin ||
          request.headers["content-type"] !==
            "application/x-www-form-urlencoded"
        )
          throw new HttpError(403, "Open this preview from Fleet Manager.");
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 256)
            throw new HttpError(413, "Preview launch request is too large.");
        }
        const ticket = new URLSearchParams(body).get("ticket");
        if (
          !ticket ||
          !/^[a-f0-9]{64}$/.test(ticket) ||
          grant.ticketHash !== hash(ticket) ||
          Date.now() >= grant.ticketExpiresAt ||
          !this.valid(grant)
        )
          throw new HttpError(
            403,
            "Preview launch expired. Open a new preview from Fleet Manager.",
          );
        grant.ticketHash = null;
        const token = secret();
        grant.cookieHash = hash(token);
        response.writeHead(303, {
          Location: "/",
          "Set-Cookie": `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'none'; frame-ancestors 'none'",
        });
        response.end();
        return true;
      }
      this.authorizeRequest(request, grant, false);
      if (request.url?.startsWith("/.machdoch/"))
        throw new HttpError(404, "Reserved preview route.");
      await this.proxy(request, response, grant);
    } catch (error) {
      this.error(response, error);
    }
    return true;
  }
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean {
    if (this.matchesHost(request)) {
      socket.once("error", () => socket.destroy());
      try {
        const grant = this.requestGrant(request);
        this.authorizeRequest(request, grant, true);
        if (
          request.url?.startsWith("/.machdoch/") ||
          request.headers.upgrade?.toLowerCase() !== "websocket"
        )
          throw new HttpError(400, "Unsupported upgrade.");
        void this.proxy(request, socket, grant, head).catch(() =>
          socket.destroy(),
        );
      } catch {
        rejectUpgrade(socket, 403, "Forbidden");
      }
      return true;
    }
    const match = /^\/api\/gateway\/preview\/([a-f0-9-]{36})$/.exec(
      request.url ?? "",
    );
    if (!match) return false;
    const id = match[1]!;
    const pending = this.pending.get(id);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (
      this.closed ||
      !pending ||
      !token ||
      hash(token) !== pending.tokenHash ||
      !this.valid(pending.grant)
    ) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return true;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    try {
      this.server.handleUpgrade(request, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.once("close", () => this.sockets.delete(ws));
        ws.once("error", () => ws.terminate());
        const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
        stream.on("error", () => ws.terminate());
        pending.resolve(stream);
      });
    } catch {
      pending.reject(new Error("Preview handshake failed."));
      socket.destroy();
    }
    return true;
  }
  private host(request: IncomingMessage): string {
    return (request.headers.host ?? "").toLowerCase();
  }
  private requestGrant(request: IncomingMessage): Grant {
    const id = /^p-([a-f0-9]{24})\./.exec(this.host(request))?.[1];
    const grant = id ? this.grants.get(id) : null;
    if (
      !grant ||
      this.host(request) !== new URL(grant.origin).host ||
      !this.valid(grant)
    )
      throw new HttpError(
        410,
        "Preview expired or its host disconnected. Open a new preview from Fleet Manager.",
      );
    return grant;
  }
  private valid(grant: Grant): boolean {
    return (
      !this.closed &&
      Date.now() < grant.expiresAt &&
      (grant.cookieHash !== null || Date.now() < grant.ticketExpiresAt) &&
      this.runtime.gateways.generation(grant.instanceId) === grant.generation &&
      this.runtime.authStore.isSessionActive(grant.sessionHash, nowSeconds())
    );
  }
  private revoke(grant: Grant): void {
    this.grants.delete(grant.id);
    for (const close of grant.connections) close();
    for (const [id, pending] of this.pending)
      if (pending.grant === grant) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error("Preview access was revoked."));
      }
  }
  private authorizeRequest(
    request: IncomingMessage,
    grant: Grant,
    upgrade: boolean,
  ): void {
    const cookies = (request.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith(`${cookieName}=`));
    const cookie = cookies[0]?.slice(cookieName.length + 1);
    if (
      cookies.length !== 1 ||
      !cookie ||
      !/^[a-f0-9]{64}$/.test(cookie) ||
      !grant.cookieHash ||
      hash(cookie) !== grant.cookieHash
    )
      throw new HttpError(401, "Open this private preview from Fleet Manager.");
    const origin = request.headers.origin;
    if (
      (upgrade && origin !== grant.origin) ||
      (origin && origin !== grant.origin) ||
      (request.headers["sec-fetch-site"] === "cross-site" &&
        request.headers["sec-fetch-mode"] !== "navigate")
    )
      throw new HttpError(
        403,
        "Cross-origin preview requests are blocked. Route your API under this preview origin.",
      );
    if (
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        request.method ?? "",
      )
    )
      throw new HttpError(405, "Unsupported preview method.");
    if (
      !request.url?.startsWith("/") ||
      request.url.startsWith("//") ||
      /[\p{Cc}\s\\]/u.test(request.url)
    )
      throw new HttpError(400, "Invalid preview path.");
  }
  private async openTunnel(
    grant: Grant,
    target: PreviewTarget,
    signal: AbortSignal,
  ): Promise<Duplex> {
    if (signal.aborted || !this.valid(grant))
      throw new Error("Preview closed.");
    const id = randomUUID();
    const token = secret();
    let stream: Duplex | undefined;
    let rejectPending!: (error: Error) => void;
    const connected = new Promise<Duplex>((resolve, reject) => {
      rejectPending = reject;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Preview connection timed out."));
      }, 12000);
      timer.unref();
      this.pending.set(id, {
        tokenHash: hash(token),
        grant,
        resolve: (value) => {
          stream = value;
          resolve(value);
        },
        reject,
        timer,
      });
    });
    const abort = (): void => {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(id);
      stream?.destroy();
      rejectPending(new Error("Preview closed."));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const [tunnel] = await Promise.all([
        connected,
        this.runtime.gateways
          .relay(
            grant.instanceId,
            { type: "openPreviewTunnel", target, tunnelId: id, token },
            signal,
          )
          .then((response) => {
            if (response.type === "error")
              throw new HttpError(502, response.message);
            if (response.type !== "previewTunnelReady")
              throw new Error("Invalid preview tunnel response.");
          }),
      ]);
      if (signal.aborted || !this.valid(grant))
        throw new Error("Preview service is unavailable.");
      return tunnel;
    } catch (error) {
      abort();
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async proxy(
    request: IncomingMessage,
    outgoing: ServerResponse | Duplex,
    grant: Grant,
    head?: Buffer,
  ): Promise<void> {
    const allConnections = [...this.grants.values()].reduce(
      (n, g) => n + g.connections.size,
      0,
    );
    const hostConnections = [...this.grants.values()]
      .filter((g) => g.instanceId === grant.instanceId)
      .reduce((n, g) => n + g.connections.size, 0);
    if (
      allConnections >= 128 ||
      hostConnections >= 32 ||
      grant.connections.size >= 24
    )
      throw new HttpError(429, "Preview connection limit reached.");
    const controller = new AbortController();
    let tunnel: Duplex | undefined;
    let upstream: ReturnType<typeof httpRequest> | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      controller.abort();
      tunnel?.destroy();
      upstream?.destroy();
      outgoing.removeListener("close", close);
      request.removeListener("aborted", close);
      grant.connections.delete(close);
    };
    // This timer also ends silent WebSockets and SSE streams when their grant expires.
    const deadline = setTimeout(
      () => {
        outgoing.destroy();
        close();
      },
      Math.max(1, grant.expiresAt - Date.now()),
    );
    deadline.unref();
    grant.connections.add(close);
    outgoing.once("close", close);
    request.once("aborted", close);
    try {
      let path = request.url!;
      const pathname = new URL(path, grant.origin).pathname;
      const route = grant.routes.find(
        (r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`),
      );
      const target = route
        ? {
            workspace: grant.target.workspace,
            configurationId: route.configurationId,
            port: route.port,
          }
        : grant.target;
      if (route?.stripPrefix) path = path.slice(route.prefix.length) || "/";
      if (path.startsWith("?")) path = `/${path}`;
      tunnel = await this.openTunnel(grant, target, controller.signal);
      if (closed || outgoing.destroyed) {
        tunnel.destroy();
        return;
      }
      const headers = previewHeaders(request.headers);
      headers.host = new URL(grant.origin).host;
      headers["x-forwarded-host"] = headers.host;
      headers["x-forwarded-proto"] = new URL(grant.origin).protocol.slice(
        0,
        -1,
      );
      if (head) {
        headers.connection = "Upgrade";
        headers.upgrade = "websocket";
      } else headers.connection = "close";
      upstream = httpRequest(
        {
          method: request.method,
          path,
          headers,
          createConnection: () => tunnel as Socket,
          setHost: false,
          maxHeaderSize: 32 * 1024,
        },
        (response) => {
          if (head) {
            response.destroy();
            outgoing.destroy();
            close();
            return;
          }
          const res = outgoing as ServerResponse;
          const responseHeaders = previewHeaders(response.headers, true);
          if (responseHeaders.location) {
            try {
              const location = new URL(responseHeaders.location);
              if (
                ["localhost", "127.0.0.1", "[::1]"].includes(
                  location.hostname,
                ) &&
                Number(location.port) === target.port
              )
                responseHeaders.location = `${grant.origin}${route?.stripPrefix ? route.prefix : ""}${location.pathname}${location.search}${location.hash}`;
            } catch {
              /* Relative application redirects remain relative. */
            }
          }
          responseHeaders["referrer-policy"] = "no-referrer";
          responseHeaders["cache-control"] = "no-store";
          responseHeaders["x-content-type-options"] = "nosniff";
          responseHeaders["x-accel-buffering"] = "no";
          res.writeHead(response.statusCode ?? 502, responseHeaders);
          pipeline(response, res, () => close());
        },
      );
      const headerDeadline = setTimeout(() => {
        if (!closed) {
          if (!head)
            this.error(
              outgoing as ServerResponse,
              new HttpError(504, "Preview server did not respond in time."),
            );
          else outgoing.destroy();
          close();
        }
      }, 30000);
      headerDeadline.unref();
      upstream.once("response", () => clearTimeout(headerDeadline));
      upstream.once("close", () => clearTimeout(headerDeadline));
      upstream.once("error", () => {
        if (!head)
          this.error(
            outgoing as ServerResponse,
            new HttpError(
              502,
              "Preview server disconnected. Check its status and logs.",
            ),
          );
        else outgoing.destroy();
        close();
      });
      upstream.once("upgrade", (response, socket, initial) => {
        clearTimeout(headerDeadline);
        if (!head || response.statusCode !== 101) {
          socket.destroy();
          outgoing.destroy();
          close();
          return;
        }
        const filtered = previewHeaders(response.headers, true);
        filtered.connection = "Upgrade";
        filtered.upgrade = "websocket";
        let wire = "HTTP/1.1 101 Switching Protocols\r\n";
        for (const [key, value] of Object.entries(filtered))
          for (const entry of Array.isArray(value)
            ? value
            : value === undefined
              ? []
              : [String(value)])
            wire += `${key}: ${entry}\r\n`;
        outgoing.write(`${wire}\r\n`);
        if (initial.length) outgoing.write(initial);
        if (head.length) socket.write(head);
        pipeline(outgoing as Duplex, socket, outgoing as Duplex, () => close());
      });
      if (head) upstream.end();
      else {
        let uploaded = 0;
        request.on("data", (chunk: Buffer) => {
          uploaded += chunk.length;
          if (uploaded > 100 * 1024 * 1024) {
            this.error(
              outgoing as ServerResponse,
              new HttpError(413, "Preview uploads are limited to 100 MiB."),
            );
            close();
          }
        });
        request.pipe(upstream);
      }
    } catch (error) {
      close();
      throw error;
    }
  }
  private error(response: ServerResponse, error: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(error instanceof HttpError ? error.status : 502, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      Connection: "close",
    });
    response.end(
      error instanceof HttpError
        ? error.message
        : "Preview is unavailable. Check the service and reopen it from Fleet Manager.",
    );
  }
}
