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
  const region = env.MACHDOCH_LANGDOCK_REGION?.trim().toLowerCase();

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
  const configuredBaseURL = env.MACHDOCH_LANGDOCK_BASE_URL;

  if (configuredBaseURL?.trim()) {
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
