import {
  gatewayProtocolVersion,
  hostMessageSchema,
  maximumGatewayMessageBytes,
  productCapability,
  workspaceRunsCapability,
  type HostMessage,
  type HostRequest,
  type HostResponse,
  managerMessageSchema,
} from "@machdoch/fleet-protocol";
import WebSocket, { type RawData } from "ws";
import { CliConfigurationError } from "./cli-error.js";
import {
  loadFleetConnectionConfig,
  validateFleetManagerUrl,
  type FleetConnectionConfig,
} from "../../core/fleet-connection.js";

export type FleetGatewayPhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disabled"
  | "stopped";

export interface FleetGatewayStatusEvent {
  phase: FleetGatewayPhase;
  message?: string;
}

interface FleetGatewayConnectionResult {
  reconnect: boolean;
  message: string;
}

export interface FleetGatewayServiceResult {
  reason: "disabled" | "stopped";
}

export interface FleetGatewayServiceOptions {
  signal: AbortSignal;
  productVersion: string;
  handleRequest: (request: HostRequest) => Promise<HostResponse>;
  onStatus?: (event: FleetGatewayStatusEvent) => void;
  loadConfig?: () => Promise<FleetConnectionConfig | null>;
  reconnectDelaysMs?: readonly number[];
  configPollIntervalMs?: number;
}

const permanentCloseCodes = new Set([1002, 1003, 1007, 1008, 1009, 1010]);
const maximumPendingRequests = 8;
const maximumBufferedBytes = 8 * 1024 * 1024;
class OversizedGatewayMessageError extends Error {}

const wait = async (durationMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

const connectionFingerprint = (config: FleetConnectionConfig): string =>
  JSON.stringify(config);

export const createFleetGatewayUrl = (
  config: Pick<FleetConnectionConfig, "managerUrl" | "instanceId">,
): string => {
  const url = validateFleetManagerUrl(config.managerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/gateway/connect/${encodeURIComponent(config.instanceId)}`;
  return url.toString();
};

const rawDataBuffer = (data: RawData): Buffer => {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
};

const boundedMessage = (message: string): string =>
  message.length <= 12_000 ? message : `${message.slice(0, 11_999)}…`;

const sendHostMessage = async (
  socket: WebSocket,
  message: HostMessage,
): Promise<void> => {
  const parsed = hostMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new Error("Fleet host produced an invalid gateway message.");
  }
  const payload = JSON.stringify(parsed.data);
  if (Buffer.byteLength(payload) > maximumGatewayMessageBytes) {
    throw new OversizedGatewayMessageError(
      "Fleet gateway message exceeded the configured limit.",
    );
  }
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Fleet gateway connection closed.");
  }
  if (
    socket.bufferedAmount + Buffer.byteLength(payload) >
    maximumBufferedBytes
  ) {
    throw new Error("Fleet gateway write buffer is full.");
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error | null): void => {
      clearTimeout(timer);
      socket.removeListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = (): void =>
      finish(new Error("Fleet gateway connection closed."));
    const timer = setTimeout(
      () => finish(new Error("Fleet gateway write timed out.")),
      10_000,
    );
    timer.unref();
    socket.once("close", onClose);
    try {
      socket.send(payload, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
};

const gatewayErrorResponse = (error: unknown): HostResponse => ({
  type: "error",
  code: "internal",
  message: boundedMessage(
    error instanceof Error ? error.message : "Fleet request failed.",
  ),
});

const closeMessage = (
  code: number,
  reason: Buffer,
): FleetGatewayConnectionResult => {
  const normalizedReason = reason
    .toString("utf8")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim();
  const message = normalizedReason
    ? `Fleet Manager closed the connection: ${normalizedReason}`
    : `Fleet gateway connection closed (${code}).`;
  return { reconnect: !permanentCloseCodes.has(code), message };
};

export const runFleetGatewayConnection = async (options: {
  config: FleetConnectionConfig;
  signal: AbortSignal;
  productVersion: string;
  handleRequest: (request: HostRequest) => Promise<HostResponse>;
  onConnected?: () => void;
}): Promise<FleetGatewayConnectionResult> => {
  if (options.signal.aborted) {
    return { reconnect: false, message: "Fleet service stopped." };
  }

  return await new Promise<FleetGatewayConnectionResult>((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(createFleetGatewayUrl(options.config), {
        headers: { Authorization: `Bearer ${options.config.instanceSecret}` },
        handshakeTimeout: 30_000,
        maxPayload: maximumGatewayMessageBytes,
        perMessageDeflate: false,
      });
    } catch (error) {
      resolve({
        reconnect: false,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let settled = false;
    let lastError: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let activeRequests = 0;
    let activePreviewRequests = 0;
    let pendingBytes = 0;
    let lastReceived = performance.now();
    let closeDeadline: NodeJS.Timeout | undefined;

    const finish = (result: FleetGatewayConnectionResult): void => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      options.signal.removeEventListener("abort", stop);
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "Fleet service stopped.");
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      if (socket.readyState !== WebSocket.CLOSED) {
        closeDeadline = setTimeout(() => socket.terminate(), 5_000);
        closeDeadline.unref();
      }
      resolve(result);
    };

    const stop = (): void =>
      finish({ reconnect: false, message: "Fleet service stopped." });

    options.signal.addEventListener("abort", stop, { once: true });

    socket.once("unexpected-response", (_request, response) => {
      response.destroy();
      const status = response.statusCode ?? 0;
      const message =
        status === 409
          ? "Fleet Manager rejected a duplicate instance connection."
          : [401, 403, 404].includes(status)
            ? "Fleet Manager rejected the instance credentials."
            : `Fleet Manager rejected the gateway connection (${status}).`;
      finish({ reconnect: ![401, 403, 404].includes(status), message });
    });

    socket.once("open", () => {
      if (settled) return;
      void sendHostMessage(socket, {
        type: "hello",
        instanceId: options.config.instanceId,
        protocolVersion: gatewayProtocolVersion,
        productVersion: options.productVersion,
        capabilities: [productCapability, workspaceRunsCapability],
      })
        .then(() => {
          if (settled) return;
          options.onConnected?.();
          heartbeat = setInterval(() => {
            if (performance.now() - lastReceived > 60_000) {
              finish({
                reconnect: true,
                message: "Fleet gateway became unresponsive.",
              });
              return;
            }
            socket.ping();
            void sendHostMessage(socket, {
              type: "heartbeat",
              sentAt: Date.now(),
            }).catch((error: unknown) => {
              finish({
                reconnect: true,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          }, 15_000);
          heartbeat.unref();
        })
        .catch((error: unknown) => {
          finish({
            reconnect: true,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    });

    socket.on("message", (data, isBinary) => {
      if (settled) return;
      lastReceived = performance.now();
      const payload = rawDataBuffer(data);
      if (isBinary || payload.byteLength > maximumGatewayMessageBytes) {
        socket.close(1003, "Unsupported gateway message.");
        finish({ reconnect: false, message: "Unsupported gateway message." });
        return;
      }
      let input: unknown;
      try {
        input = JSON.parse(payload.toString("utf8")) as unknown;
      } catch {
        socket.close(1007, "Invalid gateway message.");
        finish({ reconnect: false, message: "Invalid gateway message." });
        return;
      }
      const parsed = managerMessageSchema.safeParse(input);
      if (!parsed.success) {
        socket.close(1008, "Invalid gateway message.");
        finish({ reconnect: false, message: "Invalid gateway message." });
        return;
      }
      if (parsed.data.type === "disconnect") {
        finish({
          reconnect: false,
          message: parsed.data.reason.replace(/[\p{Cc}\p{Cf}]/gu, " "),
        });
        return;
      }
      const { requestId, request } = parsed.data;
      const previewRequest = request.type === "openPreviewTunnel";
      if (
        (previewRequest
          ? activePreviewRequests >= 32
          : activeRequests >= maximumPendingRequests) ||
        pendingBytes + payload.byteLength > maximumBufferedBytes
      ) {
        void sendHostMessage(socket, {
          type: "response",
          requestId,
          response: {
            type: "error",
            code: "unavailable",
            message: "The Fleet CLI service is busy.",
          },
        }).catch((error: unknown) => {
          finish({
            reconnect: true,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      if (previewRequest) activePreviewRequests += 1;
      else activeRequests += 1;
      pendingBytes += payload.byteLength;
      void Promise.resolve()
        .then(() => (settled ? undefined : options.handleRequest(request)))
        .catch(gatewayErrorResponse)
        .then(async (response) => {
          if (settled || !response) return;
          try {
            await sendHostMessage(socket, {
              type: "response",
              requestId,
              response,
            });
          } catch (error) {
            if (!(error instanceof OversizedGatewayMessageError)) throw error;
            await sendHostMessage(socket, {
              type: "response",
              requestId,
              response: {
                type: "error",
                code: "unavailable",
                message: error.message,
              },
            });
          }
        })
        .catch((error: unknown) => {
          finish({
            reconnect: true,
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (previewRequest) activePreviewRequests -= 1;
          else activeRequests -= 1;
          pendingBytes -= payload.byteLength;
        });
    });

    socket.on("ping", () => {
      lastReceived = performance.now();
    });
    socket.on("pong", () => {
      lastReceived = performance.now();
    });
    socket.on("error", (error) => {
      lastError = error.message;
      finish({
        reconnect: true,
        message: `Fleet gateway connection failed: ${error.message}`,
      });
    });

    socket.once("close", (code, reason) => {
      if (closeDeadline) clearTimeout(closeDeadline);
      if (settled) return;
      const result = closeMessage(code, reason);
      finish({
        ...result,
        message: lastError
          ? `Fleet gateway connection failed: ${lastError}`
          : result.message,
      });
    });
  });
};

const monitorFleetConfig = async (options: {
  initialConfig: FleetConnectionConfig;
  intervalMs: number;
  signal: AbortSignal;
  loadConfig: () => Promise<FleetConnectionConfig | null>;
  onChanged: (config: FleetConnectionConfig | null, error?: unknown) => void;
}): Promise<void> => {
  const initialFingerprint = connectionFingerprint(options.initialConfig);
  while (!options.signal.aborted) {
    await wait(options.intervalMs, options.signal);
    if (options.signal.aborted) return;
    try {
      const config = await options.loadConfig();
      if (
        !config ||
        !config.enabled ||
        connectionFingerprint(config) !== initialFingerprint
      ) {
        options.onChanged(config);
        return;
      }
    } catch (error) {
      options.onChanged(null, error);
      return;
    }
  }
};

export const runFleetGatewayService = async (
  options: FleetGatewayServiceOptions,
): Promise<FleetGatewayServiceResult> => {
  const loadConfig = options.loadConfig ?? loadFleetConnectionConfig;
  const reconnectDelays = options.reconnectDelaysMs ?? [
    1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000,
  ];
  const configPollIntervalMs = options.configPollIntervalMs ?? 1_000;
  let reconnectAttempt = 0;
  // Keep the limit across reconnects: unfinished work on an old socket still counts.
  let activeRequests = 0;
  const handleRequest = async (request: HostRequest): Promise<HostResponse> => {
    if (activeRequests >= maximumPendingRequests)
      return {
        type: "error",
        code: "unavailable",
        message: "The Fleet CLI service is busy.",
      };
    activeRequests += 1;
    try {
      return await options.handleRequest(request);
    } finally {
      activeRequests -= 1;
    }
  };
  let config = await loadConfig();

  if (!config?.enabled) {
    options.onStatus?.({ phase: "disabled" });
    return { reason: "disabled" };
  }

  while (!options.signal.aborted) {
    options.onStatus?.({ phase: "connecting" });
    const connectionController = new AbortController();
    const monitorController = new AbortController();
    const connectionSignal = AbortSignal.any([
      options.signal,
      connectionController.signal,
    ]);
    let changedConfig: FleetConnectionConfig | null | undefined;
    let configError: unknown;
    let connectedAt: number | undefined;
    const monitor = monitorFleetConfig({
      initialConfig: config,
      intervalMs: configPollIntervalMs,
      signal: AbortSignal.any([options.signal, monitorController.signal]),
      loadConfig,
      onChanged: (nextConfig, error) => {
        changedConfig = nextConfig;
        configError = error;
        connectionController.abort("Fleet configuration changed.");
      },
    });
    const result = await runFleetGatewayConnection({
      config,
      signal: connectionSignal,
      productVersion: options.productVersion,
      handleRequest,
      onConnected: () => {
        connectedAt = performance.now();
        options.onStatus?.({ phase: "connected" });
      },
    });
    monitorController.abort();
    await monitor;

    if (options.signal.aborted) break;
    if (configError)
      throw new CliConfigurationError(
        configError instanceof Error
          ? configError.message
          : String(configError),
      );
    if (changedConfig !== undefined) {
      if (!changedConfig?.enabled) {
        options.onStatus?.({ phase: "disabled" });
        return { reason: "disabled" };
      }
      config = changedConfig;
      reconnectAttempt = 0;
      continue;
    }
    if (!result.reconnect) {
      throw new CliConfigurationError(result.message);
    }
    if (connectedAt !== undefined && performance.now() - connectedAt >= 60_000)
      reconnectAttempt = 0;

    const baseDelay =
      reconnectDelays[
        Math.min(reconnectAttempt, Math.max(0, reconnectDelays.length - 1))
      ] ?? 60_000;
    const delay = Math.max(0, baseDelay) * (0.8 + Math.random() * 0.4);
    reconnectAttempt += 1;
    options.onStatus?.({
      phase: "reconnecting",
      message: `${result.message} Retrying in ${Math.ceil(delay / 1_000)} seconds.`,
    });
    await wait(delay, options.signal);
    if (options.signal.aborted) break;
    const current = await loadConfig();
    if (!current?.enabled) {
      options.onStatus?.({ phase: "disabled" });
      return { reason: "disabled" };
    }
    config = current;
  }

  options.onStatus?.({ phase: "stopped" });
  return { reason: "stopped" };
};
