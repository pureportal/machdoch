import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS } from "../../../../core/runtime-contract.generated.js";
import { DesktopTaskRunProtocolError } from "../../desktop-task-error";
import type { AutomaticRetrySettings } from "./execution-retry-policy";
import type { PromptEnhancementAttempt } from "./prompt-enhancement-attempt";
import { PromptEnhancementCancellationError } from "./prompt-enhancement";
import { runPromptEnhancement } from "./run-prompt-enhancement";

const success = {
  execution: {
    status: "executed" as const,
    summary:
      "<machdoch_enhanced_prompt>Enhanced request</machdoch_enhanced_prompt>",
  },
};

const createHarness = (previousAttempt?: PromptEnhancementAttempt) => {
  let settings: AutomaticRetrySettings = {
    ...DEFAULT_USER_AGENT_LIMITS_SETTINGS,
  };
  const controller = new AbortController();
  const persist = vi.fn(async (_attempt: PromptEnhancementAttempt) => {});
  const run = vi
    .fn<Parameters<typeof runPromptEnhancement>[0]["run"]>()
    .mockResolvedValue(success);
  const assertActive = vi.fn();
  return {
    controller,
    persist,
    run,
    assertActive,
    setSettings: (next: AutomaticRetrySettings) => {
      settings = next;
    },
    start: () =>
      runPromptEnhancement({
        taskId: "enhancement",
        task: "Enhance the original request; do not execute it.",
        previousAttempt,
        signal: controller.signal,
        getSettings: () => settings,
        assertActive,
        persist,
        run,
      }),
  };
};

describe("prompt enhancement retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  it("uses the global defaults and backoff with distinct native task IDs and recovery context", async () => {
    expect(DEFAULT_USER_AGENT_LIMITS_SETTINGS).toMatchObject({
      automaticRetries: true,
      retryAttempts: 2,
    });
    const harness = createHarness();
    harness.run.mockRejectedValueOnce(new Error("HTTP 503"));
    const result = harness.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.persist.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "waiting",
      readyAt: 12_000,
      execution: { retryNumber: 1 },
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("Enhanced request");
    expect(harness.run.mock.calls.map((call) => call[1])).toEqual([
      "enhancement",
      "enhancement-retry-1",
    ]);
    expect(harness.run.mock.calls[1][0]).toContain(
      "Enhance the original request; do not execute it.",
    );
    expect(harness.run.mock.calls[1][0]).toContain("HTTP 503");
  });

  it("exhausts two additional attempts and retains the final failure", async () => {
    const harness = createHarness();
    harness.run.mockResolvedValue({
      execution: { status: "failed", summary: "Provider failed" },
    });
    const result = expect(harness.start()).rejects.toThrow("Provider failed");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(harness.run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(harness.run).toHaveBeenCalledTimes(3);
    expect(harness.persist.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "failed",
      failureMessage: "Provider failed",
      execution: { retryNumber: 2 },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { automaticRetries: false, retryAttempts: 2 },
    { automaticRetries: true, retryAttempts: 0 },
  ])("does not retry with settings %j", async (settings) => {
    const harness = createHarness();
    harness.setSettings(settings);
    harness.run.mockRejectedValue(new Error("Failed"));
    await expect(harness.start()).rejects.toThrow("Failed");
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies a settings change while a retry waits", async () => {
    const harness = createHarness();
    harness.run.mockRejectedValueOnce(new Error("Failed"));
    const result = expect(harness.start()).rejects.toThrow("Failed");
    await vi.advanceTimersByTimeAsync(0);
    harness.setSettings({ automaticRetries: false, retryAttempts: 2 });
    await vi.advanceTimersByTimeAsync(2_000);
    await result;
    expect(harness.run).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting retry immediately without starting another task", async () => {
    const harness = createHarness();
    harness.run.mockRejectedValueOnce(new Error("Failed"));
    const result = expect(harness.start()).rejects.toBeInstanceOf(
      PromptEnhancementCancellationError,
    );
    await vi.advanceTimersByTimeAsync(0);
    harness.controller.abort();
    await result;
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.persist.mock.calls.at(-1)?.[0].status).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards success returned after cancellation", async () => {
    const harness = createHarness();
    harness.run.mockImplementationOnce(async () => {
      harness.controller.abort();
      return success;
    });
    await expect(harness.start()).rejects.toBeInstanceOf(
      PromptEnhancementCancellationError,
    );
    expect(harness.run).toHaveBeenCalledTimes(1);
  });

  it.each(["blocked", "unsupported", "cancelled"] as const)(
    "does not retry a %s result",
    async (status) => {
      const harness = createHarness();
      harness.run.mockResolvedValue({ execution: { status, summary: status } });
      await expect(harness.start()).rejects.toThrow();
      expect(harness.run).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { kind: "cancelled", message: "Cancelled remotely" } as const,
    { kind: "operation-already-active", activeTaskId: "other" } as const,
    { kind: "task-already-active", taskId: "other" } as const,
  ])("does not retry native $kind errors", async (failure) => {
    const harness = createHarness();
    harness.run.mockRejectedValue(new DesktopTaskRunProtocolError(failure));
    await expect(harness.start()).rejects.toThrow();
    expect(harness.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    new DesktopTaskRunProtocolError({
      kind: "timed-out",
      timeoutKind: "idle",
      message: "Timed out",
    }),
    new Error("The provider returned a failure mentioning cancelled"),
  ])(
    "retries recoverable errors without interpreting prose as cancellation",
    async (error) => {
      const harness = createHarness();
      harness.run.mockRejectedValueOnce(error);
      const result = harness.start();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toBe("Enhanced request");
    },
  );

  it("retries an empty enhancement result", async () => {
    const harness = createHarness();
    harness.run.mockResolvedValueOnce({
      execution: { status: "executed", summary: "" },
    });
    const result = harness.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toBe("Enhanced request");
    expect(harness.run).toHaveBeenCalledTimes(2);
  });

  it("does not retry persistence failures or start unpersisted work", async () => {
    const harness = createHarness();
    harness.persist.mockRejectedValue(new Error("Disk unavailable"));
    await expect(harness.start()).rejects.toThrow("Disk unavailable");
    expect(harness.run).not.toHaveBeenCalled();
  });

  it("does not restart a cancelled persisted enhancement", async () => {
    const harness = createHarness({
      execution: {
        rootTaskId: "enhancement",
        task: "Enhance",
        retryNumber: 1,
        retryLimit: 2,
      },
      status: "cancelled",
      updatedAt: 5_000,
    });
    await expect(harness.start()).rejects.toBeInstanceOf(
      PromptEnhancementCancellationError,
    );
    expect(harness.run).not.toHaveBeenCalled();
  });
});
