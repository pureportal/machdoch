import { describe, expect, it, vi } from "vitest";
import { retryRalphPersistenceOperation } from "./retry-ralph-persistence.helper.js";

describe("RALPH persistence recovery", () => {
  it("retries temporary errors until the operation succeeds", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("locked"), { code: "EPERM" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("busy"), { code: "EBUSY" }),
      )
      .mockResolvedValue("saved");
    await expect(retryRalphPersistenceOperation(operation)).resolves.toBe(
      "saved",
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("stops at the retry deadline", async () => {
    const error = Object.assign(new Error("locked"), { code: "EPERM" });
    const operation = vi.fn().mockRejectedValue(error);
    await expect(
      retryRalphPersistenceOperation(operation, { retryWindowMs: 25 }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each(["ENOSPC", "EROFS", "EIO"])("does not retry %s", async (code) => {
    const error = Object.assign(new Error(code), { code });
    const operation = vi.fn().mockRejectedValue(error);
    await expect(retryRalphPersistenceOperation(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending recovery delay", async () => {
    const controller = new AbortController();
    const operation = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("locked"), { code: "EPERM" }));
    const recovery = retryRalphPersistenceOperation(operation, {
      signal: controller.signal,
      onRetry: () => controller.abort(),
    });
    await expect(recovery).rejects.toMatchObject({ name: "AbortError" });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
