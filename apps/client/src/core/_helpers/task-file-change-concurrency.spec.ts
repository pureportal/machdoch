/// <reference lib="es2024.promise" />
import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrencyLimit } from "./task-file-change-concurrency.js";

describe("mapWithConcurrencyLimit", () => {
  it("bounds active work and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const output = await mapWithConcurrencyLimit(
      [3, 2, 1, 0],
      2,
      async (value) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, value));
        active -= 1;
        return value * 2;
      },
    );
    expect(output).toEqual([6, 4, 2, 0]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("stops scheduling after failure and waits for active work before rejecting", async () => {
    const blocker = Promise.withResolvers<void>();
    const failure = new Error("read failed");
    const mapper = vi.fn(async (value: number) => {
      if (value === 0) throw failure;
      await blocker.promise;
      return value;
    });
    let settled = false;
    const result = mapWithConcurrencyLimit([0, 1, 2, 3], 2, mapper).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mapper.mock.calls.map(([value]) => value)).toEqual([0, 1]);
    blocker.resolve();
    expect(await result).toBe(failure);
    expect(mapper).toHaveBeenCalledTimes(2);
  });

  it.each([NaN, 0, -1, -Infinity])(
    "still processes all values with limit %s",
    async (limit) => {
      expect(
        await mapWithConcurrencyLimit([1, 2], limit, async (value) => value),
      ).toEqual([1, 2]);
    },
  );
});
