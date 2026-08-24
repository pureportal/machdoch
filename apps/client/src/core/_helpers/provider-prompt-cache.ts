import type { AgentModelToolSpec } from "../types.js";
import type { ConfiguredModelProvider } from "../provider-model-registry.js";
import { getProviderCapabilityProfile } from "../model-capabilities.js";
import { sha256, stableJson } from "../provider-enrollment/digests.js";

export interface ProviderPromptCacheDirectives {
  cacheKey?: string;
  cacheSystemPrompt: boolean;
}

export const resolveProviderPromptCacheDirectives = (
  provider: ConfiguredModelProvider,
  model: string,
  systemPrompt: string,
  tools: readonly AgentModelToolSpec[],
): ProviderPromptCacheDirectives => {
  const capability = getProviderCapabilityProfile(provider)?.promptCaching;

  if (capability === "automatic-keyed") {
    const prefixDigest = sha256(
      stableJson({ model, systemPrompt, tools }),
    ).slice(0, 48);

    return {
      cacheKey: `machdoch-${prefixDigest}`,
      cacheSystemPrompt: false,
    };
  }

  return {
    cacheSystemPrompt: capability === "explicit",
  };
};
