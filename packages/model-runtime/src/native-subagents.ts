import { getDiscoveredModelCapabilities } from "./model-capabilities.ts";
import type { ModelProvider } from "./types.ts";
export const supportsNativeSubagents = (
  provider: ModelProvider,
  model: string,
): boolean => {
  if (!model.trim()) return false;

  switch (provider) {
    case "codex-cli":
    case "copilot-cli":
      return true;
    case "claude-cli":
      return (
        getDiscoveredModelCapabilities(provider, model)?.nativeSubagents ?? true
      );
    case "openai":
      return /^gpt-(?:5\.6(?:-(?:sol|terra|luna))?|6-(?:astra|sol|luna))(?:-\d{4}-\d{2}-\d{2})?$/iu.test(
        model,
      );
    default:
      return false;
  }
};
