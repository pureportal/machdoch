import { useSyncExternalStore } from "react";
import {
  agentControlEndpointSchema,
  type AgentControlEndpoint,
} from "@machdoch/fleet-protocol/task-thinking";

const CONTROL_TIMEOUT_MS = 10_000;
const endpoints = new Map<string, AgentControlEndpoint>();
const listeners = new Set<() => void>();
let version = 0;

const isLoopbackUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
};

const notify = (): void => {
  version += 1;
  for (const listener of listeners) listener();
};

/**
 * Records where a running task accepts steering, answers and stop requests.
 * `null` (sent when the turn ends) forgets it.
 */
export const setAgentControlEndpoint = (taskId: string, value: unknown): void => {
  if (value === null) {
    if (endpoints.delete(taskId)) notify();
    return;
  }
  const parsed = agentControlEndpointSchema.safeParse(value);
  if (!parsed.success || !isLoopbackUrl(parsed.data.url)) return;
  const previous = endpoints.get(taskId);
  if (previous?.url === parsed.data.url && previous.token === parsed.data.token) return;
  endpoints.set(taskId, parsed.data);
  notify();
};

export const forgetAgentControlEndpoint = (taskId: string): void => {
  if (endpoints.delete(taskId)) notify();
};

export const getAgentControlEndpoint = (
  taskId: string | undefined,
): AgentControlEndpoint | undefined => (taskId ? endpoints.get(taskId) : undefined);

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The live control endpoint of a task, re-rendering when it changes. */
export const useAgentControlEndpoint = (
  taskId: string | undefined,
): AgentControlEndpoint | undefined => {
  useSyncExternalStore(subscribe, () => version, () => version);
  return getAgentControlEndpoint(taskId);
};

export type AgentControlAction =
  | { type: "steer"; text: string }
  | { type: "interrupt" }
  | { type: "answer"; questionId: string; answers: Record<string, string> }
  | { type: "stop-task"; taskId: string };

const ROUTES: Record<AgentControlAction["type"], string> = {
  steer: "/v1/steer",
  interrupt: "/v1/interrupt",
  answer: "/v1/answer",
  "stop-task": "/v1/tasks/stop",
};

/** Sends input into a running task; throws with a readable message on failure. */
export const sendAgentControl = async (
  taskId: string,
  action: AgentControlAction,
): Promise<void> => {
  const endpoint = endpoints.get(taskId);
  if (!endpoint) {
    throw new Error("This run no longer accepts input.");
  }
  const { type, ...payload } = action;
  const body =
    action.type === "stop-task" ? { taskId: action.taskId } : payload;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${endpoint.url}${ROUTES[type]}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // A slow reply does not mean the run is gone; keep its controls.
    if (controller.signal.aborted) {
      throw new Error("The run did not respond in time. Try again.");
    }
    forgetAgentControlEndpoint(taskId);
    throw new Error("The run stopped accepting input.");
  } finally {
    window.clearTimeout(timeout);
  }
  if (response.ok) return;
  let message = `The run rejected the request (${response.status}).`;
  try {
    const result = (await response.json()) as { error?: unknown };
    if (typeof result.error === "string" && result.error.trim()) message = result.error;
  } catch {
    // Keep the status-based message.
  }
  throw new Error(message);
};
