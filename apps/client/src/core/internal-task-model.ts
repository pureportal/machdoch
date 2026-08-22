import { createProviderAdapter } from "./_helpers/provider-adapters.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";
import type {
  AgentModelAdapter,
  AgentModelToolSpec,
} from "./types.js";

export interface InternalTaskModelExecution {
  config: RuntimeConfig;
  adapter: AgentModelAdapter;
}

export const resolveInternalTaskRuntimeConfig = (
  config: RuntimeConfig,
): RuntimeConfig | null => {
  const provider = config.internalTaskModel.provider;
  const model = config.internalTaskModel.model.trim();

  if (provider === "unconfigured" || !model) {
    return null;
  }

  return {
    ...config,
    provider,
    model,
  };
};

export const requireInternalTaskRuntimeConfig = (
  config: RuntimeConfig,
): RuntimeConfig => {
  const internalConfig = resolveInternalTaskRuntimeConfig(config);

  if (!internalConfig) {
    throw new Error(
      "Choose an internal task model in Settings > Providers before running this AI task.",
    );
  }

  return internalConfig;
};

export const createInternalTaskModelExecution = async (
  config: RuntimeConfig,
  tools: AgentModelToolSpec[] = [],
  overrideAdapter?: AgentModelAdapter,
): Promise<InternalTaskModelExecution | null> => {
  const internalConfig = resolveInternalTaskRuntimeConfig(config);

  if (!internalConfig) {
    return null;
  }

  const adapter = await createProviderAdapter(
    internalConfig,
    tools,
    overrideAdapter,
  );

  return adapter ? { config: internalConfig, adapter } : null;
};
