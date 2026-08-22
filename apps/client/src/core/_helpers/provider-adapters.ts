import { hasConfiguredValue, loadWorkspaceEnv } from "../env.js";
import type {
  AgentModelAdapter,
  AgentModelToolSpec,
} from "../types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";

const LANGDOCK_DEFAULT_REGION = "eu";
const LANGDOCK_SUPPORTED_REGIONS = new Set(["eu", "us"]);
const LANGDOCK_API_PROTOCOLS = new Set([
  "openai",
  "anthropic",
  "google",
  "mistral",
]);

type LangdockSDKProtocol = "openai" | "anthropic" | "google";

interface LangdockParsedBaseURL {
  root: string;
  region?: string;
}

const stripTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/u, "");

const resolveLangdockRegion = (env: Record<string, string>): string => {
  const region = env.LANGDOCK_REGION?.trim().toLowerCase();

  return region && LANGDOCK_SUPPORTED_REGIONS.has(region)
    ? region
    : LANGDOCK_DEFAULT_REGION;
};

const stripKnownLangdockEndpointSuffix = (value: string): string => {
  return stripTrailingSlashes(value)
    .replace(/\/chat\/completions$/iu, "")
    .replace(/\/messages$/iu, "")
    .replace(/\/fim\/completions$/iu, "")
    .replace(
      /\/models(?:\/[^/]+(?::(?:generateContent|streamGenerateContent))?)?$/iu,
      "",
    );
};

const createURLRoot = (url: URL, rootPath: string): string => {
  const port = url.port ? `:${url.port}` : "";
  const origin = `${url.protocol}//${url.hostname}${port}`;
  const normalizedRootPath = stripTrailingSlashes(rootPath);

  return normalizedRootPath ? `${origin}${normalizedRootPath}` : origin;
};

const parseLangdockBaseURL = (
  value: string,
): LangdockParsedBaseURL | undefined => {
  try {
    const normalizedBaseURL = stripKnownLangdockEndpointSuffix(value);
    const url = new URL(normalizedBaseURL);
    const segments = stripTrailingSlashes(url.pathname)
      .split("/")
      .filter(Boolean);

    if (segments.length === 0) {
      return { root: createURLRoot(url, "") };
    }

    if (segments.length === 2 && segments.join("/") === "api/public") {
      return { root: createURLRoot(url, "/api/public") };
    }

    for (let index = 0; index < segments.length - 1; index += 1) {
      const protocol = segments[index]?.toLowerCase();
      const region = segments[index + 1]?.toLowerCase();

      if (
        !protocol ||
        !region ||
        !LANGDOCK_API_PROTOCOLS.has(protocol) ||
        !LANGDOCK_SUPPORTED_REGIONS.has(region)
      ) {
        continue;
      }

      return {
        root: createURLRoot(url, `/${segments.slice(0, index).join("/")}`),
        region,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const appendLangdockSDKPath = (
  baseURLRoot: string,
  protocol: LangdockSDKProtocol,
  region: string,
): string => {
  const root = stripTrailingSlashes(baseURLRoot);

  switch (protocol) {
    case "openai":
      return `${root}/openai/${region}/v1`;
    case "anthropic":
      return `${root}/anthropic/${region}`;
    case "google":
      return `${root}/google/${region}`;
  }
};

const resolveLangdockSDKBaseURL = (
  env: Record<string, string>,
  protocol: LangdockSDKProtocol,
): string => {
  const configuredRegion = resolveLangdockRegion(env);
  const configuredBaseURL = env.LANGDOCK_BASE_URL;

  if (configuredBaseURL && hasConfiguredValue(configuredBaseURL)) {
    const normalizedBaseURL = stripKnownLangdockEndpointSuffix(
      configuredBaseURL.trim(),
    );
    const parsedBaseURL = parseLangdockBaseURL(normalizedBaseURL);

    if (parsedBaseURL) {
      return appendLangdockSDKPath(
        parsedBaseURL.root,
        protocol,
        parsedBaseURL.region ?? configuredRegion,
      );
    }

    if (protocol === "openai") {
      return normalizedBaseURL;
    }

    return appendLangdockSDKPath(normalizedBaseURL, protocol, configuredRegion);
  }

  return appendLangdockSDKPath(
    "https://api.langdock.com",
    protocol,
    configuredRegion,
  );
};

export const resolveLangdockBaseURL = (env: Record<string, string>): string => {
  return resolveLangdockSDKBaseURL(env, "openai");
};

export const resolveLangdockAnthropicBaseURL = (
  env: Record<string, string>,
): string => {
  return resolveLangdockSDKBaseURL(env, "anthropic");
};

export const resolveLangdockGoogleBaseURL = (
  env: Record<string, string>,
): string => {
  return resolveLangdockSDKBaseURL(env, "google");
};

export type LangdockModelRoute =
  | "anthropic-messages"
  | "gemini-chat"
  | "openai-chat-completions";

export const getLangdockModelRoute = (model: string): LangdockModelRoute => {
  const normalizedModel = model.trim().toLowerCase();

  if (normalizedModel.startsWith("claude-")) {
    return "anthropic-messages";
  }

  if (normalizedModel.startsWith("gemini-")) {
    return "gemini-chat";
  }

  return "openai-chat-completions";
};

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

      const [{ default: OpenAI }, { OpenAIResponsesAdapter }] = await Promise.all([
        import("openai"),
        import("./provider-adapters/openai-adapter.js"),
      ]);

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

      const [{ default: Anthropic }, { AnthropicMessagesAdapter }] =
        await Promise.all([
          import("@anthropic-ai/sdk"),
          import("./provider-adapters/anthropic-adapter.js"),
        ]);

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

      const [{ GoogleGenAI }, { GeminiChatAdapter }] = await Promise.all([
        import("@google/genai"),
        import("./provider-adapters/gemini-adapter.js"),
      ]);

      return new GeminiChatAdapter(
        new GoogleGenAI({ apiKey }),
        config.model,
        tools,
      );
    }

    case "langdock": {
      const apiKey = env.LANGDOCK_API_KEY;

      if (!apiKey || !hasConfiguredValue(apiKey)) {
        return undefined;
      }

      const langdockRoute = getLangdockModelRoute(config.model);

      if (langdockRoute === "anthropic-messages") {
        const [{ default: Anthropic }, { AnthropicMessagesAdapter }] =
          await Promise.all([
            import("@anthropic-ai/sdk"),
            import("./provider-adapters/anthropic-adapter.js"),
          ]);

        return new AnthropicMessagesAdapter(
          new Anthropic({
            apiKey: null,
            authToken: apiKey,
            baseURL: resolveLangdockAnthropicBaseURL(env),
          }),
          tools,
          "langdock",
        );
      }

      if (langdockRoute === "gemini-chat") {
        const [{ GoogleGenAI }, { GeminiChatAdapter }] = await Promise.all([
          import("@google/genai"),
          import("./provider-adapters/gemini-adapter.js"),
        ]);

        return new GeminiChatAdapter(
          new GoogleGenAI({
            apiKey,
            httpOptions: {
              apiVersion: "v1beta",
              baseUrl: resolveLangdockGoogleBaseURL(env),
            },
          }),
          config.model,
          tools,
          "langdock",
        );
      }

      const [{ default: OpenAI }, { LangdockChatCompletionsAdapter }] =
        await Promise.all([
          import("openai"),
          import("./provider-adapters/langdock-adapter.js"),
        ]);

      return new LangdockChatCompletionsAdapter(
        new OpenAI({
          apiKey,
          baseURL: resolveLangdockBaseURL(env),
        }),
        tools,
      );
    }

    case "codex-cli":
    case "claude-cli":
    case "copilot-cli":
      return undefined;
  }
};
