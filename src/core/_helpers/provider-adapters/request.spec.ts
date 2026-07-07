import { getEventListeners } from "node:events";
import {
  createProviderRequestSignal,
  getProviderRequestRetryDelayMs,
  withProviderRequest,
  type ProviderRequestLogEntry,
} from "./request.js";

describe("createProviderRequestSignal", () => {
  it("cleans up the parent abort listener after each request", () => {
    const controller = new AbortController();

    for (let index = 0; index < 12; index += 1) {
      const requestSignal = createProviderRequestSignal(controller.signal);

      expect(requestSignal.signal).toBeDefined();
      expect(requestSignal.signal).not.toBe(controller.signal);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

      requestSignal.cleanup();

      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  });

  it("forwards parent aborts to the request signal", () => {
    const controller = new AbortController();
    const requestSignal = createProviderRequestSignal(controller.signal);
    const reason = new Error("Stop request.");

    controller.abort(reason);

    expect(requestSignal.signal?.aborted).toBe(true);
    expect(requestSignal.signal?.reason).toBe(reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("withProviderRequest", () => {
  it("honors Retry-After headers when calculating provider retry delays", () => {
    expect(
      getProviderRequestRetryDelayMs(
        1,
        Object.assign(new Error("rate limit"), {
          status: 429,
          headers: new Headers({
            "retry-after-ms": "2500",
          }),
        }),
      ),
    ).toBe(2_500);

    expect(
      getProviderRequestRetryDelayMs(
        1,
        Object.assign(new Error("rate limit"), {
          status: 429,
          headers: {
            "retry-after": "2",
          },
        }),
      ),
    ).toBe(2_000);
  });

  it("retries retryable failures and logs each attempt", async () => {
    const logs: ProviderRequestLogEntry[] = [];
    let attempts = 0;
    const retryableError = Object.assign(new Error("rate limit"), {
      status: 429,
    });

    await expect(
      withProviderRequest(
        {
          provider: "openai",
          operation: "startTurn",
          maxAttempts: 2,
          retryDelayMs: () => 0,
          logger: (entry) => logs.push(entry),
        },
        async () => {
          attempts += 1;

          if (attempts === 1) {
            throw retryableError;
          }

          return "ok";
        },
      ),
    ).resolves.toBe("ok");

    expect(attempts).toBe(2);
    expect(logs).toMatchObject([
      {
        provider: "openai",
        operation: "startTurn",
        attempt: 1,
        ok: false,
        errorMessage: "rate limit",
      },
      {
        provider: "openai",
        operation: "startTurn",
        attempt: 2,
        ok: true,
      },
    ]);
  });

  it("does not retry aborts", async () => {
    const controller = new AbortController();
    let attempts = 0;

    controller.abort(new Error("User cancelled."));

    await expect(
      withProviderRequest(
        {
          provider: "google",
          operation: "continueTurn",
          signal: controller.signal,
          maxAttempts: 2,
          retryDelayMs: () => 0,
        },
        async (requestSignal) => {
          attempts += 1;
          throw requestSignal?.reason ?? new Error("Missing abort signal.");
        },
      ),
    ).rejects.toThrow("User cancelled.");

    expect(attempts).toBe(1);
  });

  it("adds Langdock endpoint guidance to 400 No body provider errors", async () => {
    const providerError = Object.assign(new Error("400 No body"), {
      status: 400,
    });

    await expect(
      withProviderRequest(
        {
          provider: "langdock",
          operation: "startTurn",
          maxAttempts: 2,
          retryDelayMs: () => 0,
        },
        async () => {
          throw providerError;
        },
      ),
    ).rejects.toThrow(
      /LANGDOCK_BASE_URL.*https:\/\/api\.langdock\.com\/openai\/eu\/v1.*Original error: 400 No body/s,
    );
  });

  it("adds Langdock rate-limit guidance to 429 provider errors", async () => {
    const providerError = Object.assign(new Error("429 status code (no body)"), {
      status: 429,
      code: "rate_limit",
      request_id: "req_langdock_429",
    });
    let caughtError: unknown;

    try {
      await withProviderRequest(
        {
          provider: "langdock",
          operation: "startTurn",
          maxAttempts: 1,
        },
        async () => {
          throw providerError;
        },
      );
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError).toMatchObject({
      status: 429,
      code: "rate_limit",
      request_id: "req_langdock_429",
    });
    expect((caughtError as Error).message).toMatch(
      /Langdock Chat Completions rate limits are enforced at the workspace level and per model/s,
    );
    expect((caughtError as Error).message).toContain(
      "Original error: 429 status code (no body)",
    );
  });

  it("preserves unrelated non-retryable provider errors", async () => {
    const providerError = Object.assign(new Error("invalid model"), {
      status: 400,
    });

    await expect(
      withProviderRequest(
        {
          provider: "openai",
          operation: "startTurn",
          maxAttempts: 2,
          retryDelayMs: () => 0,
        },
        async () => {
          throw providerError;
        },
      ),
    ).rejects.toBe(providerError);
  });
});
