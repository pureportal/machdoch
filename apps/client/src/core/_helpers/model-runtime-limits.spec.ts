import { afterEach, expect, it, vi } from "vitest";
import { createModelAdapter } from "@machdoch/model-runtime/connections";

afterEach(() => vi.unstubAllEnvs());

it("bounds Responses output and sends only the explicitly selected provider identity", async () => {
  vi.stubEnv("OPENAI_ORG_ID", "ambient-organization");
  vi.stubEnv("OPENAI_PROJECT_ID", "ambient-project");
  vi.stubEnv("OPENAI_BASE_URL", "https://ambient.invalid");
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      id: "response-1",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Bounded answer", annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
    }),
  );
  const adapter = await createModelAdapter(
    {
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "explicit-test-key",
      fetch: request,
    },
    [],
  );
  const result = await adapter.startTurn({
    model: "gpt-5.5",
    systemPrompt: "System",
    userPrompt: "Question",
    tools: [],
    maxOutputTokens: 64,
    maxRequestAttempts: 1,
    storeResponses: false,
  });
  expect(result.text).toBe("Bounded answer");
  const [url, options] = request.mock.calls[0]!;
  expect(String(url)).toBe("https://api.openai.com/v1/responses");
  const headers = new Headers(options?.headers);
  expect(headers.get("authorization")).toBe("Bearer explicit-test-key");
  expect(headers.has("openai-organization")).toBe(false);
  expect(headers.has("openai-project")).toBe(false);
  expect(JSON.parse(String(options?.body))).toMatchObject({
    max_output_tokens: 64,
    store: false,
    tools: [],
  });
});

it("does not multiply retries inside the SDK when a cloud request has one attempt", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Response.json(
        { error: { message: "Provider unavailable" } },
        { status: 503 },
      ),
    );
  const adapter = await createModelAdapter(
    {
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "test-key",
      fetch: request,
    },
    [],
  );
  await expect(
    adapter.startTurn({
      model: "gpt-5.5",
      systemPrompt: "System",
      userPrompt: "Question",
      tools: [],
      maxOutputTokens: 64,
      maxRequestAttempts: 1,
    }),
  ).rejects.toMatchObject({ status: 503 });
  expect(request).toHaveBeenCalledTimes(1);
});

it("bounds Anthropic output and does not mix an ambient bearer token with the configured key", async () => {
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token");
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      id: "message-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Bounded answer" }],
      usage: { input_tokens: 4, output_tokens: 3 },
    }),
  );
  const adapter = await createModelAdapter(
    {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "explicit-test-key",
      fetch: request,
    },
    [],
  );
  const result = await adapter.startTurn({
    model: "claude-sonnet-4-6",
    systemPrompt: "System",
    userPrompt: "Question",
    tools: [],
    maxOutputTokens: 64,
    maxRequestAttempts: 1,
  });
  expect(result.text).toBe("Bounded answer");
  const [, options] = request.mock.calls[0]!;
  const headers = new Headers(options?.headers);
  expect(headers.get("x-api-key")).toBe("explicit-test-key");
  expect(headers.has("authorization")).toBe(false);
  expect(JSON.parse(String(options?.body)).max_tokens).toBe(64);
});
