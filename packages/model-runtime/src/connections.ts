import type {
  AgentModelAdapter,
  AgentModelToolSpec,
  ReasoningExecutionMode,
} from "./types.ts";
import {
  getLangdockModelRoute,
  resolveLangdockAnthropicBaseURL,
  resolveLangdockBaseURL,
  resolveLangdockGoogleBaseURL,
} from "./langdock.ts";

export type ApiModelProvider = "openai" | "anthropic" | "google" | "langdock";
export interface ModelConnection {
  provider: ApiModelProvider;
  apiKey: string;
  model: string;
  reasoningMode?: ReasoningExecutionMode;
  baseUrl?: string;
  region?: "eu" | "us";
  fetch?: typeof globalThis.fetch;
}

export async function createModelAdapter(
  connection: ModelConnection,
  tools: AgentModelToolSpec[],
): Promise<AgentModelAdapter> {
  const requestFetch = connection.fetch ?? globalThis.fetch;
  const langdock = {
    MACHDOCH_LANGDOCK_BASE_URL: connection.baseUrl ?? "",
    MACHDOCH_LANGDOCK_REGION: connection.region ?? "eu",
  };
  const route =
    connection.provider === "langdock"
      ? getLangdockModelRoute(connection.model)
      : connection.provider;
  if (route === "openai") {
    const [{ default: OpenAI }, { OpenAIResponsesAdapter }] = await Promise.all(
      [import("openai"), import("./providers/openai-adapter.ts")],
    );
    return new OpenAIResponsesAdapter(
      new OpenAI({
        apiKey: connection.apiKey,
        organization: null,
        project: null,
        baseURL: connection.baseUrl ?? "https://api.openai.com/v1",
        fetch: requestFetch,
        maxRetries: 0,
      }),
      tools,
      connection.reasoningMode ?? "standard",
    );
  }
  if (route === "anthropic" || route === "anthropic-messages") {
    const [{ default: Anthropic }, { AnthropicMessagesAdapter }] =
      await Promise.all([
        import("@anthropic-ai/sdk"),
        import("./providers/anthropic-adapter.ts"),
      ]);
    const client = new Anthropic({
      ...(connection.provider === "langdock"
        ? { apiKey: null, authToken: connection.apiKey }
        : { apiKey: connection.apiKey, authToken: null }),
      baseURL:
        connection.provider === "langdock"
          ? resolveLangdockAnthropicBaseURL(langdock)
          : (connection.baseUrl ?? "https://api.anthropic.com"),
      fetch: requestFetch,
      maxRetries: 0,
    });
    return new AnthropicMessagesAdapter(
      client,
      tools,
      connection.provider === "langdock" ? "langdock" : "anthropic",
    );
  }
  if (route === "google") {
    const [{ GoogleGenAI }, { GoogleInteractionsAdapter }] = await Promise.all([
      import("@google/genai"),
      import("./providers/google-interactions.ts"),
    ]);
    return new GoogleInteractionsAdapter(
      new GoogleGenAI({
        apiKey: connection.apiKey,
        enterprise: false,
        httpOptions: {
          apiVersion: "v1",
          baseUrl:
            connection.baseUrl ?? "https://generativelanguage.googleapis.com",
          retryOptions: { attempts: 1 },
        },
      }),
    );
  }
  if (route === "gemini-chat") {
    const [{ GoogleGenAI }, { LangdockGeminiAdapter }] = await Promise.all([
      import("@google/genai"),
      import("./providers/langdock-gemini-adapter.ts"),
    ]);
    return new LangdockGeminiAdapter(
      new GoogleGenAI({
        apiKey: connection.apiKey,
        enterprise: false,
        httpOptions: {
          apiVersion: "v1beta",
          baseUrl: resolveLangdockGoogleBaseURL(langdock),
          headers: { Authorization: `Bearer ${connection.apiKey}` },
          retryOptions: { attempts: 1 },
        },
      }),
      connection.model,
      tools,
    );
  }
  const [{ default: OpenAI }, { LangdockChatCompletionsAdapter }] =
    await Promise.all([
      import("openai"),
      import("./providers/langdock-adapter.ts"),
    ]);
  return new LangdockChatCompletionsAdapter(
    new OpenAI({
      apiKey: connection.apiKey,
      organization: null,
      project: null,
      baseURL: resolveLangdockBaseURL(langdock),
      fetch: requestFetch,
      maxRetries: 0,
    }),
    tools,
  );
}
