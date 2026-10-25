import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentToolDefinition } from "./agent-tools-shared.js";

export type AgentToolPolicy = (definition: AgentToolDefinition) => boolean;
const policies = new AsyncLocalStorage<readonly AgentToolPolicy[]>();

export function withAgentToolPolicy<T>(
  policy: AgentToolPolicy,
  operation: () => T,
): T {
  return policies.run([...(policies.getStore() ?? []), policy], operation);
}

export function isAgentToolGranted(definition: AgentToolDefinition): boolean {
  return policies.getStore()?.every((policy) => policy(definition)) ?? true;
}
