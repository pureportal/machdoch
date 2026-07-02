import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import { AnthropicMessagesAdapter } from "./provider-adapters/anthropic-adapter.js";
import { GeminiChatAdapter } from "./provider-adapters/gemini-adapter.js";
import { LangdockChatCompletionsAdapter } from "./provider-adapters/langdock-adapter.js";
import {
  createProviderAdapter,
  getLangdockModelRoute,
  resolveLangdockAnthropicBaseURL,
  resolveLangdockBaseURL,
  resolveLangdockGoogleBaseURL,
} from "./provider-adapters.js";

describe("resolveLangdockBaseURL", () => {
  it("defaults to the Langdock OpenAI-compatible EU base URL", () => {
    expect(resolveLangdockBaseURL({})).toBe(
      "https://api.langdock.com/openai/eu/v1",
    );
  });

  it("normalizes Langdock Cloud roots with the configured region", () => {
    expect(
      resolveLangdockBaseURL({
        LANGDOCK_BASE_URL: "https://api.langdock.com/",
        LANGDOCK_REGION: "us",
      }),
    ).toBe("https://api.langdock.com/openai/us/v1");
  });

  it("normalizes dedicated deployment roots with the configured region", () => {
    expect(
      resolveLangdockBaseURL({
        LANGDOCK_BASE_URL: "https://langdock.example.com/api/public/",
        LANGDOCK_REGION: "us",
      }),
    ).toBe("https://langdock.example.com/api/public/openai/us/v1");
  });

  it("preserves OpenAI-compatible bases and strips endpoint suffixes", () => {
    expect(
      resolveLangdockBaseURL({
        LANGDOCK_BASE_URL:
          "https://api.langdock.com/openai/eu/v1/chat/completions",
      }),
    ).toBe("https://api.langdock.com/openai/eu/v1");
  });

  it("derives provider-specific bases from a dedicated deployment root", () => {
    const env = {
      LANGDOCK_BASE_URL: "https://langdock.example.com/api/public",
      LANGDOCK_REGION: "us",
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
      LANGDOCK_BASE_URL:
        "https://api.langdock.com/google/us/v1beta/models/gemini-2.5-pro:generateContent",
      LANGDOCK_REGION: "eu",
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
  const createConfig = (workspaceRoot: string, model: string): RuntimeConfig => ({
    workspaceRoot,
    mode: "machdoch",
    provider: "langdock",
    model,
    reasoning: "default",
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
  });

  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-langdock-"));
    await writeFile(
      join(workspaceRoot, ".env"),
      [
        "LANGDOCK_API_KEY=sk-real-langdock-test",
        "LANGDOCK_BASE_URL=https://api.langdock.com",
      ].join("\n"),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workspaceRoot, { force: true, recursive: true });
  });

  it("instantiates the documented provider adapter for Langdock model families", async () => {
    await expect(
      createProviderAdapter(createConfig(workspaceRoot, "gpt-5.5"), [], undefined),
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
    ).resolves.toBeInstanceOf(GeminiChatAdapter);
  });
});
