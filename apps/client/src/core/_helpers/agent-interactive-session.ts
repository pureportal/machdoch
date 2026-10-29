import type { AgentLiveTracker } from "./agent-live-tracker.js";
import {
  AgentControlRequestError,
  type AgentTaskControlHandlers,
} from "./agent-task-control-server.js";
import type {
  ExternalAgentCliOutputDecoder,
  ExternalAgentCliOutputUpdate,
} from "./external-agent-cli-output.js";

/**
 * A provider session that owns its own stdin for the length of one turn:
 * it writes the opening messages, answers provider requests, and accepts
 * steering, answers and stop requests from the host while the turn runs.
 */
export interface InteractiveAgentSession extends ExternalAgentCliOutputDecoder {
  readonly live: AgentLiveTracker;
  readonly controls: AgentTaskControlHandlers;
  /** Writes the opening messages. The runner must not write or close stdin. */
  start(): void;
  /** Asks the provider to end the turn. Returns false when nothing was sent. */
  interrupt(): boolean;
  /** Releases timers once the runner has settled. */
  dispose(): void;
}

export interface InteractiveSessionIo {
  write(message: string): void;
  closeInput(): void;
}

const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** Splits newline-delimited JSON across arbitrary chunk boundaries. */
export class JsonLineSplitter {
  private pending = "";
  private discarding = false;

  push(chunk: string, onLine: (line: string) => void): void {
    let remaining = chunk;
    while (remaining.length > 0) {
      const newline = remaining.indexOf("\n");
      if (newline === -1) {
        this.append(remaining);
        return;
      }
      const fragment = remaining.slice(0, newline);
      remaining = remaining.slice(newline + 1);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (this.pending.length + fragment.length > MAX_LINE_CHARS) {
        this.pending = "";
        continue;
      }
      const line = `${this.pending}${fragment}`.replace(/\r$/u, "");
      this.pending = "";
      if (line.trim()) onLine(line);
    }
  }

  finish(onLine: (line: string) => void): void {
    const line = this.pending.replace(/\r$/u, "");
    this.pending = "";
    this.discarding = false;
    if (line.trim()) onLine(line);
  }

  private append(fragment: string): void {
    if (this.discarding) return;
    if (this.pending.length + fragment.length > MAX_LINE_CHARS) {
      this.pending = "";
      this.discarding = true;
      return;
    }
    this.pending += fragment;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseJsonRecord = (
  line: string,
): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const mergeOutputUpdate = (
  target: ExternalAgentCliOutputUpdate,
  next: ExternalAgentCliOutputUpdate,
): void => {
  target.displayText.push(...next.displayText);
  if (next.resultExitCode !== undefined) {
    target.resultExitCode = next.resultExitCode;
  }
};

export const readString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof value[key] === "string" && value[key].length > 0
    ? (value[key] as string)
    : undefined;

export const readNumber = (
  value: Record<string, unknown>,
  key: string,
): number | undefined =>
  typeof value[key] === "number" && Number.isFinite(value[key])
    ? (value[key] as number)
    : undefined;

/** Converts provider epoch values (seconds or milliseconds, or ISO text) to ms. */
export const toEpochMs = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.round(value * 1_000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/** What an unattended run tells a provider that asks the user a question. */
export const UNATTENDED_ANSWER =
  "Nobody can answer during this run. Choose the most reasonable option, note the assumption, and continue.";

export type RpcId = string | number;

export type JsonRpcIncoming<Meta> =
  | { kind: "response"; method: string; meta: Meta; result: Record<string, unknown>; error?: string }
  | { kind: "request"; id: RpcId; method: string; params: Record<string, unknown> }
  | { kind: "notification"; method: string; params: Record<string, unknown> };

/**
 * Request bookkeeping for a CLI that speaks JSON-RPC over stdio: numbers
 * outgoing requests, remembers what each was for, and sorts what comes back
 * into responses, server requests and notifications.
 */
export class JsonRpcPeer<Meta extends object = Record<string, never>> {
  private nextId = 1;
  private readonly pending = new Map<number, { method: string; meta: Meta }>();

  constructor(
    private readonly send: (message: Record<string, unknown>) => void,
    /** Fields every message carries, such as `{ jsonrpc: "2.0" }`. */
    private readonly envelope: Record<string, unknown> = {},
  ) {}

  request(method: string, params: Record<string, unknown>, meta = {} as Meta): void {
    const id = this.nextId++;
    this.pending.set(id, { method, meta });
    this.send({ ...this.envelope, id, method, params });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ ...this.envelope, method, params });
  }

  respond(id: RpcId, result: Record<string, unknown>): void {
    this.send({ ...this.envelope, id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ ...this.envelope, id, error: { code, message } });
  }

  classify(message: Record<string, unknown>): JsonRpcIncoming<Meta> | undefined {
    const method = readString(message, "method");
    const id =
      typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    const params = isRecord(message.params) ? message.params : {};
    if (method) {
      return id === undefined
        ? { kind: "notification", method, params }
        : { kind: "request", id, method, params };
    }
    const pending = id === undefined ? undefined : this.pending.get(Number(id));
    if (!pending) return undefined;
    this.pending.delete(Number(id));
    const error = isRecord(message.error)
      ? (readString(message.error, "message") ?? "The request failed.")
      : undefined;
    return {
      kind: "response",
      method: pending.method,
      meta: pending.meta,
      result: isRecord(message.result) ? message.result : {},
      ...(error ? { error } : {}),
    };
  }
}

export const turnFinishedError = (): AgentControlRequestError =>
  new AgentControlRequestError("The turn has finished, so the message was not sent into it.");

export const staleQuestionError = (): AgentControlRequestError =>
  new AgentControlRequestError("This question is no longer waiting for an answer.");

/** Marks the pending question answered or cancelled in the live state. */
export const settleLiveQuestion = (
  live: AgentLiveTracker,
  status: "answered" | "cancelled",
  answers?: Record<string, string>,
): void => {
  const question = live.getQuestion();
  if (question?.status !== "pending") return;
  live.setQuestion({ ...question, status, ...(answers ? { answers } : {}) });
};

/** Reads a provider's answer options into the live question format. */
export const readQuestionOptions = (
  value: unknown,
): { label: string; description?: string }[] =>
  (Array.isArray(value) ? value : [])
    .filter(isRecord)
    .slice(0, 12)
    .flatMap((option) => {
      const label = readString(option, "label");
      if (!label) return [];
      const description = readString(option, "description");
      return [{ label, ...(description ? { description } : {}) }];
    });
