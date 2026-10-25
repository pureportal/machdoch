import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import { AnthropicMessagesAdapter } from "@machdoch/model-runtime/providers/anthropic-adapter";
import { LangdockGeminiAdapter } from "@machdoch/model-runtime/providers/langdock-gemini-adapter";
import { LangdockChatCompletionsAdapter } from "@machdoch/model-runtime/providers/langdock-adapter";
import {
  getLangdockModelRoute,
  resolveLangdockAnthropicBaseURL,
  resolveLangdockBaseURL,
  resolveLangdockGoogleBaseURL,
} from "@machdoch/model-runtime/langdock";
import {
  createProviderAdapter,
  withProviderAdapterFactory,
} from "./provider-adapters.js";
import type { AgentModelAdapter } from "@machdoch/model-runtime/types";

it("keeps broker factories scoped across concurrent tasks and ahead of local credentials", async () => {
  const first: AgentModelAdapter = {
    startTurn: async () => ({ text: "first", toolCalls: [] }),
    continueTurn: async () => ({ text: "first", toolCalls: [] }),
  };
  const second: AgentModelAdapter = {
    startTurn: async () => ({ text: "second", toolCalls: [] }),
    continueTurn: async () => ({ text: "second", toolCalls: [] }),
  };
  const config = {
    provider: "openai",
    model: "scoped",
    offline: true,
  } as RuntimeConfig;
  const [a, b] = await Promise.all([
    withProviderAdapterFactory(
      () => first,
      async () => {
        await Promise.resolve();
        return createProviderAdapter(config, [], second);
      },
    ),
    withProviderAdapterFactory(
      () => second,
      async () => {
        await Promise.resolve();
        return createProviderAdapter(config, [], first);
      },
    ),
  ]);
  expect(a).toBe(first);
  expect(b).toBe(second);
  expect(await createProviderAdapter(config, [], first)).toBe(first);
});
describe("resolveLangdockBaseURL", () => {
  it("defaults to the Langdock OpenAI-compatible EU base URL", () => {
    expect(resolveLangdockBaseURL({})).toBe(
      "https://api.langdock.com/openai/eu/v1",
    );
  });

  it("normalizes Langdock Cloud roots with the configured region", () => {
    expect(
      resolveLangdockBaseURL({
        MACHDOCH_LANGDOCK_BASE_URL: "https://api.langdock.com/",
        MACHDOCH_LANGDOCK_REGION: "us",
      }),
    ).toBe("https://api.langdock.com/openai/us/v1");
  });

  it("normalizes dedicated deployment roots with the configured region", () => {
    expect(
      resolveLangdockBaseURL({
        MACHDOCH_LANGDOCK_BASE_URL: "https://langdock.example.com/api/public/",
        MACHDOCH_LANGDOCK_REGION: "us",
      }),
    ).toBe("https://langdock.example.com/api/public/openai/us/v1");
  });

  it("preserves OpenAI-compatible bases and strips endpoint suffixes", () => {
    expect(
      resolveLangdockBaseURL({
        MACHDOCH_LANGDOCK_BASE_URL:
          "https://api.langdock.com/openai/eu/v1/chat/completions",
      }),
    ).toBe("https://api.langdock.com/openai/eu/v1");
  });

  it("derives provider-specific bases from a dedicated deployment root", () => {
    const env = {
      MACHDOCH_LANGDOCK_BASE_URL: "https://langdock.example.com/api/public",
      MACHDOCH_LANGDOCK_REGION: "us",
    };

    expect(resolveLangdockBaseURL(env)).toBe(
      "https://langdock.example.com/api/public/openai/us/v1",
    );
    expect(resolveLangdockAnthropicBaseURL(env)).toBe(
      "https://langdock.example.com/api/public/anthropic/us",
    );
    expect(resolveLangdockGoogleBaseURL(env)).toBe(
      "https://langdock.example.com/api/public/google/us",
    );
  });

  it("derives sibling provider bases from an already configured Langdock endpoint", () => {
    const env = {
      MACHDOCH_LANGDOCK_BASE_URL:
        "https://api.langdock.com/google/us/v1beta/models/gemini-2.5-pro:generateContent",
      MACHDOCH_LANGDOCK_REGION: "eu",
    };

    expect(resolveLangdockBaseURL(env)).toBe(
      "https://api.langdock.com/openai/us/v1",
    );
    expect(resolveLangdockAnthropicBaseURL(env)).toBe(
      "https://api.langdock.com/anthropic/us",
    );
    expect(resolveLangdockGoogleBaseURL(env)).toBe(
      "https://api.langdock.com/google/us",
    );
  });
});

describe("getLangdockModelRoute", () => {
  it("routes Langdock model families to the documented provider APIs", () => {
    expect(getLangdockModelRoute("gpt-5.5")).toBe("openai-chat-completions");
    expect(getLangdockModelRoute("claude-sonnet-4-6-default")).toBe(
      "anthropic-messages",
    );
    expect(getLangdockModelRoute("gemini-2.5-flash")).toBe("gemini-chat");
    expect(getLangdockModelRoute("langdock-llama-3.3-70b-2")).toBe(
      "openai-chat-completions",
    );
  });
});

describe("createProviderAdapter Langdock routing", () => {
  const createConfig = (
    workspaceRoot: string,
    model: string,
  ): RuntimeConfig => ({
    workspaceRoot,
    mode: "machdoch",
    provider: "langdock",
    model,
    reasoning: "default",
    contextWindow: "default",
    offline: false,
    compatibility: {},
    providerAvailability: [],
    webSearch: {
      activeProvider: "none",
      providerAvailability: [],
    },
    reviewModel: {
      mode: "base",
    },
    internalTaskModel: {
      provider: "langdock",
      model,
      reasoning: "default",
    },
  });

  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-langdock-"));
    vi.stubEnv("LANGDOCK_API_KEY", "sk-real-langdock-test");
    vi.stubEnv("MACHDOCH_LANGDOCK_BASE_URL", "https://api.langdock.com");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(workspaceRoot, { force: true, recursive: true });
  });

  it("instantiates the documented provider adapter for Langdock model families", async () => {
    await expect(
      createProviderAdapter(
        createConfig(workspaceRoot, "gpt-5.5"),
        [],
        undefined,
      ),
    ).resolves.toBeInstanceOf(LangdockChatCompletionsAdapter);
    await expect(
      createProviderAdapter(
        createConfig(workspaceRoot, "claude-sonnet-4-6-default"),
        [],
        undefined,
      ),
    ).resolves.toBeInstanceOf(AnthropicMessagesAdapter);
    await expect(
      createProviderAdapter(
        createConfig(workspaceRoot, "gemini-2.5-flash"),
        [],
        undefined,
      ),
    ).resolves.toBeInstanceOf(LangdockGeminiAdapter);
  });

  it("accepts model-independent context presets for fixed-size API providers", async () => {
    await expect(
      createProviderAdapter(
        {
          ...createConfig(workspaceRoot, "gpt-5.5"),
          contextWindow: "highest",
        },
        [],
        undefined,
      ),
    ).resolves.toBeInstanceOf(LangdockChatCompletionsAdapter);
  });
});
