import { getEventListeners } from "node:events";
import {
  createProviderRequestSignal,
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
});
