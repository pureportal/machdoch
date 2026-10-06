import type { RuntimeProvider } from "@machdoch/fleet-protocol/runtime-options";

export const PROVIDER_LABELS: Record<RuntimeProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  langdock: "Langdock",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
  "copilot-cli": "Copilot CLI",
};

export const getProviderLabel = (provider: RuntimeProvider): string => {
  return PROVIDER_LABELS[provider];
};
