import {
  StableFileIdentityRaceError,
  retryStableFileIdentityRace,
  retryStableFileIdentityRaceSync,
} from "./read-stable-regular-file.helper.js";

describe("stable regular file retries", () => {
  it("retries asynchronous identity races until a stable generation is read", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new StableFileIdentityRaceError("generation 1"))
      .mockRejectedValueOnce(new StableFileIdentityRaceError("generation 2"))
      .mockResolvedValue("generation 3");

    await expect(retryStableFileIdentityRace(operation)).resolves.toBe(
      "generation 3",
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("retries synchronous identity races until a stable generation is read", () => {
    let attempts = 0;
    const operation = vi.fn<() => string>(() => {
      attempts += 1;
      if (attempts < 3) {
        throw new StableFileIdentityRaceError(`generation ${attempts}`);
      }
      return `generation ${attempts}`;
    });

    expect(retryStableFileIdentityRaceSync(operation)).toBe("generation 3");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry ordinary asynchronous failures", async () => {
    const error = new Error("permission denied");
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);

    await expect(retryStableFileIdentityRace(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("does not retry ordinary synchronous failures", () => {
    const error = new Error("permission denied");
    const operation = vi.fn<() => never>(() => {
      throw error;
    });

    expect(() => retryStableFileIdentityRaceSync(operation)).toThrow(error);
    expect(operation).toHaveBeenCalledOnce();
  });
});
