import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { RunMode } from "../runtime-contract.generated.js";
import type { TaskExecutionRole } from "../types.js";

type WorkspaceAgentAccess = "read-only" | "write";
type WorkspaceAgentRole = "parent" | "worker";

export interface WorkspaceAgentClaims {
  readPaths?: string[];
  writePaths?: string[];
  exclusiveResources?: string[];
}

export interface ActiveWorkspaceAgent {
  agentId: string;
  parentAgentId?: string;
  role: WorkspaceAgentRole;
  access: WorkspaceAgentAccess;
  activity: TaskExecutionRole;
  startedAt: number;
  claims?: WorkspaceAgentClaims;
}

export type WorkspacePresenceSnapshot =
  | { status: "available"; agents: ActiveWorkspaceAgent[] }
  | { status: "unknown" };

interface WorkspaceControlResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface WorkspacePresenceContext {
  agentId: string;
  workspaceRoot: string;
}

export interface WorkspacePresenceEnrollment {
  address: string;
  token: string;
  agentId: string;
}

interface PresenceRegistration {
  agentId: string;
  registrationKey: string;
  parentAgentId?: string;
  role: WorkspaceAgentRole;
  access: WorkspaceAgentAccess;
  activity: TaskExecutionRole;
  claims: WorkspaceAgentClaims;
}

interface PendingResponse {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

const CONNECTION_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const presenceContext = new AsyncLocalStorage<WorkspacePresenceContext>();

const readControlEndpoint = ():
  | { address: string; host: string; port: number; token: string }
  | undefined => {
  const address = process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
  const token = process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN;
  if (!address || !token) return undefined;
  const separator = address.lastIndexOf(":");
  const host = address.slice(0, separator);
  const port = Number(address.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return { address, host, port, token };
};

const parseControlResponse = (line: string): WorkspaceControlResponse => {
  const response = JSON.parse(line) as WorkspaceControlResponse;
  if (
    !response ||
    typeof response !== "object" ||
    typeof response.ok !== "boolean"
  ) {
    throw new Error("Workspace presence returned an invalid response.");
  }
  return response;
};

type WorkspaceControlEndpoint = NonNullable<
  ReturnType<typeof readControlEndpoint>
>;

interface DesiredPresenceRegistration {
  workspaceRoot: string;
  registration: PresenceRegistration;
}

const connectPresenceSocket = async (
  endpoint: WorkspaceControlEndpoint,
): Promise<Socket | undefined> => {
  return new Promise((resolve) => {
    let socket: Socket;
    try {
      socket = createConnection({
        host: endpoint.host,
        port: endpoint.port,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let settled = false;
    const finish = (connectedSocket: Socket | undefined): void => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeListener("connect", connected);
      socket.removeListener("error", failed);
      socket.removeListener("timeout", timedOut);
      if (!connectedSocket) socket.destroy();
      resolve(connectedSocket);
    };
    const connected = (): void => finish(socket);
    const failed = (): void => finish(undefined);
    const timedOut = (): void => finish(undefined);
    socket.once("connect", connected);
    socket.once("error", failed);
    socket.once("timeout", timedOut);
    socket.setTimeout(CONNECTION_TIMEOUT_MS);
  });
};

class WorkspacePresencePublisher {
  readonly endpointKey: string;
  private readonly endpoint: WorkspaceControlEndpoint;
  private readonly desiredRegistrations = new Map<
    string,
    DesiredPresenceRegistration
  >();
  private readonly publishedAgentIds = new Set<string>();
  private socket: Socket | undefined;
  private connectionAttempt: Promise<Socket | undefined> | undefined;
  private responseText = "";
  private pendingResponses: PendingResponse[] = [];
  private operationTail: Promise<void> = Promise.resolve();
  private recoveryQueued = false;
  private stopped = false;

  constructor(endpoint: WorkspaceControlEndpoint) {
    this.endpoint = endpoint;
    this.endpointKey = `${endpoint.address}\0${endpoint.token}`;
  }

  get isClosed(): boolean {
    return this.stopped;
  }

  register(
    workspaceRoot: string,
    registration: PresenceRegistration,
  ): Promise<boolean> {
    this.desiredRegistrations.set(registration.agentId, {
      workspaceRoot,
      registration,
    });
    return this.enqueue(async () => {
      const socket = await this.ensureConnection();
      if (socket) await this.publishDesiredRegistrations();
      const registered = this.publishedAgentIds.has(registration.agentId);
      if (!registered) {
        this.desiredRegistrations.delete(registration.agentId);
        if (this.desiredRegistrations.size === 0) this.stop(false);
      }
      return registered;
    });
  }

  unregister(workspaceRoot: string, agentId: string): Promise<void> {
    this.desiredRegistrations.delete(agentId);
    return this.enqueue(async () => {
      if (this.publishedAgentIds.has(agentId)) {
        try {
          await this.send({
            token: this.endpoint.token,
            action: "unregisterPresence",
            workspaceRoot,
            agentId,
          });
        } catch (error) {
          const socket = this.socket;
          if (socket) {
            this.handleConnectionFailure(
              socket,
              error instanceof Error
                ? error
                : new Error("Workspace presence cleanup failed."),
            );
          }
        }
      }
      this.publishedAgentIds.delete(agentId);
      if (this.desiredRegistrations.size === 0) this.stop(false);
    });
  }

  destroy(): void {
    this.stop(true);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureConnection(): Promise<Socket | undefined> {
    if (this.stopped) return undefined;
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connectionAttempt) return await this.connectionAttempt;

    const attempt = connectPresenceSocket(this.endpoint);
    this.connectionAttempt = attempt;
    const socket = await attempt.catch(() => undefined);
    if (this.connectionAttempt === attempt) this.connectionAttempt = undefined;
    if (!socket || this.stopped) {
      socket?.destroy();
      return undefined;
    }
    this.attachSocket(socket);
    return socket;
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    this.responseText = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(socket, chunk));
    socket.on("error", (error) => this.handleConnectionFailure(socket, error));
    socket.on("close", () =>
      this.handleConnectionFailure(
        socket,
        new Error("Workspace presence connection closed."),
      ),
    );
  }

  private async publishDesiredRegistrations(): Promise<void> {
    for (const desired of [...this.desiredRegistrations.values()]) {
      const agentId = desired.registration.agentId;
      if (
        !this.desiredRegistrations.has(agentId) ||
        this.publishedAgentIds.has(agentId)
      ) {
        continue;
      }
      try {
        await this.send({
          token: this.endpoint.token,
          action: "registerPresence",
          workspaceRoot: desired.workspaceRoot,
          registration: desired.registration,
        });
      } catch {
        if (!this.socket) return;
        continue;
      }
      if (this.desiredRegistrations.has(agentId)) {
        this.publishedAgentIds.add(agentId);
      } else {
        try {
          await this.send({
            token: this.endpoint.token,
            action: "unregisterPresence",
            workspaceRoot: desired.workspaceRoot,
            agentId,
          });
        } catch {
          const socket = this.socket;
          if (socket) {
            this.handleConnectionFailure(
              socket,
              new Error("Workspace presence cleanup failed."),
            );
          }
          return;
        }
      }
    }
  }

  private send(request: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (this.stopped || !socket || socket.destroyed) {
      return Promise.reject(new Error("Workspace presence is unavailable."));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.handleConnectionFailure(
          socket,
          new Error("Workspace presence publication timed out."),
        );
      }, QUERY_TIMEOUT_MS);
      timeout.unref();
      this.pendingResponses.push({ resolve, reject, timeout });
      socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) this.handleConnectionFailure(socket, error);
      });
    });
  }

  private handleData(socket: Socket, chunk: string): void {
    if (socket !== this.socket) return;
    this.responseText += chunk;
    if (this.responseText.length > MAX_RESPONSE_BYTES) {
      this.handleConnectionFailure(
        socket,
        new Error("Workspace presence response is too large."),
      );
      return;
    }
    let newline = this.responseText.indexOf("\n");
    while (newline >= 0) {
      const line = this.responseText.slice(0, newline);
      this.responseText = this.responseText.slice(newline + 1);
      const pending = this.pendingResponses.shift();
      if (!pending) {
        this.handleConnectionFailure(
          socket,
          new Error("Workspace presence returned an unexpected response."),
        );
        return;
      }
      clearTimeout(pending.timeout);
      try {
        const response = parseControlResponse(line);
        if (!response.ok) {
          pending.reject(
            new Error(
              response.error || "Workspace presence publication failed.",
            ),
          );
        } else {
          pending.resolve(response.result);
        }
      } catch (error) {
        pending.reject(
          error instanceof Error
            ? error
            : new Error("Workspace presence returned invalid JSON."),
        );
      }
      newline = this.responseText.indexOf("\n");
    }
  }

  private handleConnectionFailure(socket: Socket, error: Error): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.responseText = "";
    this.publishedAgentIds.clear();
    socket.destroy();
    this.rejectPending(error);
    if (
      !this.stopped &&
      this.desiredRegistrations.size > 0 &&
      !this.recoveryQueued
    ) {
      this.recoveryQueued = true;
      void this.enqueue(async () => {
        try {
          if (this.desiredRegistrations.size === 0) return;
          const recoveredSocket = await this.ensureConnection();
          if (recoveredSocket) await this.publishDesiredRegistrations();
        } finally {
          this.recoveryQueued = false;
        }
      });
    }
  }

  private rejectPending(error: Error): void {
    const pending = this.pendingResponses;
    this.pendingResponses = [];
    for (const response of pending) {
      clearTimeout(response.timeout);
      response.reject(error);
    }
  }

  private stop(destroy: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    this.desiredRegistrations.clear();
    this.publishedAgentIds.clear();
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending(new Error("Workspace presence publisher stopped."));
    if (destroy) socket?.destroy();
    else socket?.end();
  }
}

let publisher: WorkspacePresencePublisher | undefined;

const getPublisher = (): WorkspacePresencePublisher | undefined => {
  const endpoint = readControlEndpoint();
  if (!endpoint) return undefined;
  const endpointKey = `${endpoint.address}\0${endpoint.token}`;
  if (
    publisher &&
    !publisher.isClosed &&
    publisher.endpointKey === endpointKey
  ) {
    return publisher;
  }
  publisher?.destroy();
  publisher = new WorkspacePresencePublisher(endpoint);
  return publisher;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isAgentClaims = (value: unknown): value is WorkspaceAgentClaims => {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  return (
    (claims.readPaths === undefined || isStringArray(claims.readPaths)) &&
    (claims.writePaths === undefined || isStringArray(claims.writePaths)) &&
    (claims.exclusiveResources === undefined ||
      isStringArray(claims.exclusiveResources))
  );
};

const readActiveWorkspaceAgent = (
  value: unknown,
): ActiveWorkspaceAgent | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const agent = value as Record<string, unknown>;
  if (
    typeof agent.agentId === "string" &&
    (agent.parentAgentId === undefined ||
      typeof agent.parentAgentId === "string") &&
    (agent.role === "parent" || agent.role === "worker") &&
    (agent.access === "read-only" || agent.access === "write") &&
    (agent.activity === "executor" ||
      agent.activity === "validator" ||
      agent.activity === "generator") &&
    typeof agent.startedAt === "number" &&
    Number.isFinite(agent.startedAt) &&
    (agent.claims === undefined || isAgentClaims(agent.claims))
  ) {
    const claims = agent.claims as WorkspaceAgentClaims | undefined;
    return {
      agentId: agent.agentId,
      ...(typeof agent.parentAgentId === "string"
        ? { parentAgentId: agent.parentAgentId }
        : {}),
      role: agent.role,
      access: agent.access,
      activity: agent.activity,
      startedAt: agent.startedAt,
      ...(claims
        ? {
            claims: {
              ...(claims.readPaths ? { readPaths: [...claims.readPaths] } : {}),
              ...(claims.writePaths
                ? { writePaths: [...claims.writePaths] }
                : {}),
              ...(claims.exclusiveResources
                ? { exclusiveResources: [...claims.exclusiveResources] }
                : {}),
            },
          }
        : {}),
    };
  }
  return undefined;
};

const readAvailableSnapshot = (
  value: unknown,
): WorkspacePresenceSnapshot | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.status !== "available" || !Array.isArray(snapshot.agents)) {
    return undefined;
  }
  const agents = snapshot.agents.map(readActiveWorkspaceAgent);
  if (agents.some((agent) => agent === undefined)) return undefined;
  return { status: "available", agents: agents as ActiveWorkspaceAgent[] };
};

const sendPresenceQuery = async (
  workspaceRoot: string,
  agentId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<WorkspacePresenceSnapshot> => {
  const endpoint = readControlEndpoint();
  if (!endpoint || signal?.aborted) return { status: "unknown" };
  return new Promise((resolve) => {
    const socket = createConnection({
      host: endpoint.host,
      port: endpoint.port,
    });
    let responseText = "";
    let settled = false;
    const finish = (snapshot: WorkspacePresenceSnapshot): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      resolve(snapshot);
    };
    const aborted = (): void => finish({ status: "unknown" });
    signal?.addEventListener("abort", aborted, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(QUERY_TIMEOUT_MS);
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          token: endpoint.token,
          action: "getPresence",
          workspaceRoot,
          ...(agentId ? { agentId } : {}),
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      responseText += chunk;
      if (responseText.length > MAX_RESPONSE_BYTES) {
        finish({ status: "unknown" });
        return;
      }
      const newline = responseText.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = parseControlResponse(responseText.slice(0, newline));
        const snapshot = response.ok
          ? readAvailableSnapshot(response.result)
          : undefined;
        finish(snapshot ?? { status: "unknown" });
      } catch {
        finish({ status: "unknown" });
      }
    });
    socket.on("timeout", () => finish({ status: "unknown" }));
    socket.on("error", () => finish({ status: "unknown" }));
    socket.on("end", () => finish({ status: "unknown" }));
  });
};

export const queryWorkspaceAgentPresence = async (
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<WorkspacePresenceSnapshot> => {
  const current = presenceContext.getStore();
  try {
    return await sendPresenceQuery(
      workspaceRoot,
      current?.agentId ?? process.env.MACHDOCH_WORKSPACE_AGENT_ID,
      signal,
    );
  } catch {
    return { status: "unknown" };
  }
};

export const getWorkspacePresenceEnrollment = ():
  | WorkspacePresenceEnrollment
  | undefined => {
  const endpoint = readControlEndpoint();
  const current = presenceContext.getStore();
  if (!endpoint || !current) return undefined;
  return {
    address: endpoint.address,
    token: endpoint.token,
    agentId: current.agentId,
  };
};

export const runWithWorkspaceAgentPresence = async <T>(
  workspaceRoot: string,
  mode: RunMode,
  activity: TaskExecutionRole,
  operation: () => Promise<T>,
  claims: WorkspaceAgentClaims = {},
): Promise<T> => {
  const parent = presenceContext.getStore();
  const parentAgentId =
    parent?.workspaceRoot === workspaceRoot ? parent.agentId : undefined;
  const registration: PresenceRegistration = {
    agentId: randomUUID(),
    registrationKey: randomUUID(),
    ...(parentAgentId ? { parentAgentId } : {}),
    role: parentAgentId ? "worker" : "parent",
    access: mode === "ask" ? "read-only" : "write",
    activity,
    claims,
  };
  const publisher = getPublisher();
  const registered =
    (await publisher?.register(workspaceRoot, registration)) === true;

  return presenceContext.run(
    { agentId: registration.agentId, workspaceRoot },
    async () => {
      try {
        return await operation();
      } finally {
        if (registered) {
          await publisher?.unregister(workspaceRoot, registration.agentId);
        }
      }
    },
  );
};
