import { hasConfiguredValue, loadRuntimeEnvironment } from "../env.js";
import type {
  AgentModelAdapter,
  AgentModelToolSpec,
} from "@machdoch/model-runtime/types";
import { createModelAdapter } from "@machdoch/model-runtime/connections";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import { createObservedProviderFetch } from "../model-usage.js";
import { AsyncLocalStorage } from "node:async_hooks";

type ProviderAdapterFactory = (
  config: RuntimeConfig,
  tools: AgentModelToolSpec[],
) => AgentModelAdapter | Promise<AgentModelAdapter>;
const scopedProviderAdapters = new AsyncLocalStorage<ProviderAdapterFactory>();

export function withProviderAdapterFactory<T>(
  factory: ProviderAdapterFactory,
  operation: () => T,
): T {
  return scopedProviderAdapters.run(factory, operation);
}

export const createProviderAdapter = async (
  config: RuntimeConfig,
  tools: AgentModelToolSpec[],
  overrideAdapter: AgentModelAdapter | undefined,
): Promise<AgentModelAdapter | undefined> => {
  const scopedFactory = scopedProviderAdapters.getStore();
  if (scopedFactory) return scopedFactory(config, tools);
  if (overrideAdapter) return overrideAdapter;
  const provider = config.provider;
  if (
    config.offline ||
    (provider !== "openai" &&
      provider !== "anthropic" &&
      provider !== "google" &&
      provider !== "langdock")
  )
    return undefined;
  const env = await loadRuntimeEnvironment();
  const keyName = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
    langdock: "LANGDOCK_API_KEY",
  }[provider];
  const apiKey = env[keyName];
  if (!apiKey || !hasConfiguredValue(apiKey)) return undefined;
  const baseUrl =
    provider === "langdock"
      ? env.MACHDOCH_LANGDOCK_BASE_URL
      : provider === "openai"
        ? env.OPENAI_BASE_URL
        : provider === "anthropic"
          ? env.ANTHROPIC_BASE_URL
          : undefined;
  return createModelAdapter(
    {
      provider,
      model: config.model,
      apiKey,
      reasoningMode: config.reasoningMode ?? "standard",
      region:
        env.MACHDOCH_LANGDOCK_REGION?.toLowerCase() === "us" ? "us" : "eu",
      ...(baseUrl?.trim() ? { baseUrl } : {}),
      fetch: createObservedProviderFetch(provider),
    },
    tools,
  );
};
