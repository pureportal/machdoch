import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { hasConfiguredValue, loadWorkspaceEnv } from "../env.js";
import type {
  AgentModelAdapter,
  AgentModelToolSpec,
  RuntimeConfig,
} from "../types.js";
import { AnthropicMessagesAdapter } from "./provider-adapters/anthropic-adapter.js";
import { GeminiChatAdapter } from "./provider-adapters/gemini-adapter.js";
import { OpenAIResponsesAdapter } from "./provider-adapters/openai-adapter.js";

export {
  AnthropicMessagesAdapter,
  createAnthropicToolSelection,
  createAnthropicTools,
  createAnthropicUserContent,
} from "./provider-adapters/anthropic-adapter.js";
export {
  GeminiChatAdapter,
  createGeminiTools,
  createGeminiUserMessage,
  normalizeGeminiResponse,
} from "./provider-adapters/gemini-adapter.js";
export {
  OpenAIResponsesAdapter,
  createOpenAIResponseToolSelection,
  createOpenAITools,
  createOpenAIUserInput,
} from "./provider-adapters/openai-adapter.js";
export {
  createProviderRequestSignal,
  isRetryableProviderRequestError,
  withProviderRequest,
  type ProviderRequestLogEntry,
  type ProviderRequestLogger,
  type ProviderRequestOptions,
} from "./provider-adapters/request.js";
export { normalizeOpenAIStrictInputSchema } from "./provider-adapters/schema-normalization.js";

export const createProviderAdapter = async (
  config: RuntimeConfig,
  tools: AgentModelToolSpec[],
  overrideAdapter: AgentModelAdapter | undefined,
): Promise<AgentModelAdapter | undefined> => {
  if (overrideAdapter) {
    return overrideAdapter;
  }

  if (config.provider === "unconfigured" || config.offline) {
    return undefined;
  }

  const env = await loadWorkspaceEnv(config.workspaceRoot);

  switch (config.provider) {
    case "openai": {
      if (!hasConfiguredValue(env.OPENAI_API_KEY)) {
        return undefined;
      }

      return new OpenAIResponsesAdapter(
        new OpenAI({
          apiKey: env.OPENAI_API_KEY,
        }),
        tools,
      );
    }

    case "anthropic": {
      if (!hasConfiguredValue(env.ANTHROPIC_API_KEY)) {
        return undefined;
      }

      return new AnthropicMessagesAdapter(
        new Anthropic({
          apiKey: env.ANTHROPIC_API_KEY,
        }),
        tools,
      );
    }

    case "google": {
      const apiKey = env.GOOGLE_API_KEY;

      if (!apiKey || !hasConfiguredValue(apiKey)) {
        return undefined;
      }

      return new GeminiChatAdapter(
        new GoogleGenAI({ apiKey }),
        config.model,
        tools,
      );
    }

    case "codex-cli":
    case "claude-cli":
    case "copilot-cli":
      return undefined;
  }
};
