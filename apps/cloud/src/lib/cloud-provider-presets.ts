import type { CloudProviderKind } from "@machdoch/fleet-protocol/cloud-providers";
import {
  getProviderModelMetadata,
  type ConfiguredModelProvider,
} from "@machdoch/model-runtime/provider-model-registry";

const registryProviders: Record<CloudProviderKind, ConfiguredModelProvider> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  langdock: "langdock",
  "claude-code-cli": "claude-cli",
  "codex-cli": "codex-cli",
  "copilot-cli": "copilot-cli",
};

export const providerLabels: Record<CloudProviderKind, string> = {
  "claude-code-cli": "Claude CLI",
  "codex-cli": "Codex CLI",
  "copilot-cli": "Copilot CLI",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  google: "Gemini API",
  langdock: "Langdock API",
};

export const providerChoices: CloudProviderKind[] = [
  "claude-code-cli",
  "codex-cli",
  "copilot-cli",
  "anthropic",
  "openai",
  "google",
  "langdock",
];

export const keyLabels: Record<CloudProviderKind, string> = {
  "claude-code-cli": "Anthropic API key",
  "codex-cli": "OpenAI API key",
  "copilot-cli": "GitHub token",
  anthropic: "API key",
  openai: "API key",
  google: "API key",
  langdock: "API key",
};

export const defaultProviderLimits = {
  maxOutputTokens: 8192,
  dailyTokenBudget: 1_000_000,
  maxConcurrentRequests: 4,
};

const defaultModelCount = 3;

export interface ProviderModelChoice {
  id: string;
  label: string;
}

export function providerModelChoices(
  kind: CloudProviderKind,
): ProviderModelChoice[] {
  return getProviderModelMetadata(registryProviders[kind])
    .filter((model) => model.lifecycle !== "deprecated")
    .map((model) => ({ id: model.id, label: model.label }));
}

export function defaultProviderModels(kind: CloudProviderKind): string[] {
  return getProviderModelMetadata(registryProviders[kind])
    .filter((model) => model.lifecycle === "stable")
    .slice(0, defaultModelCount)
    .map((model) => model.id);
}

export function splitProviderModels(
  kind: CloudProviderKind,
  models: string[],
): { known: string[]; custom: string[] } {
  const known = new Set(providerModelChoices(kind).map((model) => model.id));
  return {
    known: models.filter((model) => known.has(model)),
    custom: models.filter((model) => !known.has(model)),
  };
}
