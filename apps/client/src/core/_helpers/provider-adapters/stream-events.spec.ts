/// <reference types="vitest/globals" />

import {
  emitProviderStreamEvent,
  normalizeAnthropicUsage,
  normalizeGeminiUsage,
  normalizeOpenAIUsage,
} from "./stream-events.ts";

describe("emitProviderStreamEvent", () => {
  it("isolates throwing progress handlers from provider stream execution", () => {
    expect(() => {
      emitProviderStreamEvent(
        () => {
          throw new Error("progress sink failed");
        },
        {
          type: "status",
          provider: "openai",
          status: "in-progress",
          message: "Streaming.",
        },
      );
    }).not.toThrow();
  });
});

describe("provider usage normalization", () => {
  it("separates OpenAI cache reads and cache writes", () => {
    expect(
      normalizeOpenAIUsage({
        input_tokens: 100,
        output_tokens: 20,
        input_tokens_details: {
          cached_tokens: 70,
          cache_write_tokens: 10,
        },
      }),
    ).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 70,
      cacheReadInputTokens: 70,
      cacheWriteInputTokens: 10,
    });
  });

  it("counts every Anthropic input-token category without treating writes as reads", () => {
    expect(
      normalizeAnthropicUsage({
        input_tokens: 30,
        cache_creation_input_tokens: 40,
        cache_read_input_tokens: 50,
        output_tokens: 20,
      }),
    ).toMatchObject({
      inputTokens: 120,
      outputTokens: 20,
      totalTokens: 140,
      cachedInputTokens: 50,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 40,
    });
  });

  it("retains Gemini cache, tool, and reasoning token details", () => {
    expect(
      normalizeGeminiUsage({
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 125,
        cachedContentTokenCount: 60,
        toolUsePromptTokenCount: 8,
        thoughtsTokenCount: 5,
      }),
    ).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 125,
      cachedInputTokens: 60,
      cacheReadInputTokens: 60,
      toolUseInputTokens: 8,
      reasoningTokens: 5,
    });
  });
});
