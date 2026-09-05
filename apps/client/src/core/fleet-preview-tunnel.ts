import { connect } from "node:net";
import { pipeline } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import type { HostRequest } from "@machdoch/fleet-protocol";
import {
  loadFleetConnectionConfig,
  validateFleetManagerUrl,
} from "./fleet-connection.js";
import type { FleetRunManager } from "./fleet-runs.js";

export class FleetPreviewTunnels {
  private readonly active = new Set<() => void>();
  constructor(private readonly runs: FleetRunManager) {}

  async open(
    request: Extract<HostRequest, { type: "openPreviewTunnel" }>,
  ): Promise<void> {
    if (this.active.size >= 32)
      throw new Error("This host has too many preview connections.");
    const target = await this.runs.previewTarget(request.target);
    const config = await loadFleetConnectionConfig();
    if (!config) throw new Error("Fleet connection is unavailable.");
    if (target.signal.aborted || this.active.size >= 32)
      throw new Error("Preview is unavailable.");
    const url = validateFleetManagerUrl(config.managerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/api/gateway/preview/${request.tunnelId}`;
    // The one-use tunnel credential travels in a header, never a URL or project environment.
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${request.token}` },
      handshakeTimeout: 10000,
      perMessageDeflate: false,
      maxPayload: 1024 * 1024,
    });
    const local = connect({ host: target.host, port: target.port });
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      local.destroy();
      ws.terminate();
      target.signal.removeEventListener("abort", close);
      untrack();
      this.active.delete(close);
    };
    const untrack = target.track(close);
    this.active.add(close);
    const deadline = setTimeout(close, 3600000);
    deadline.unref();
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) return close();
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30000);
    heartbeat.unref();
    ws.on("pong", () => {
      alive = true;
    });
    target.signal.addEventListener("abort", close, { once: true });
    local.once("error", close);
    ws.once("error", close);
    local.once("close", close);
    ws.once("close", close);
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          local.once("connect", resolve);
          local.once("error", reject);
          local.once("close", () =>
            reject(new Error("Preview port is unavailable.")),
          );
          local.setTimeout(10000, close);
        }),
        new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
          ws.once("close", () => reject(new Error("Preview tunnel closed.")));
          ws.once("unexpected-response", (_req, response) => {
            response.destroy();
            reject(new Error("Preview tunnel was rejected."));
            close();
          });
        }),
      ]);
      if (target.signal.aborted || closed) throw new Error("Preview stopped.");
      local.setTimeout(0);
      const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
      pipeline(stream, local, stream, () => close());
    } catch (error) {
      close();
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        code === "ECONNREFUSED"
          ? "The service is not listening yet. Check its port and bind address, then retry Preview."
          : error instanceof Error &&
              error.message === "Preview tunnel was rejected."
            ? "Fleet Manager rejected the preview tunnel. Reopen the preview."
            : "Could not connect to the running service. Check its port and bind address.",
      );
    }
  }
  close(): void {
    for (const close of this.active) close();
  }
}
