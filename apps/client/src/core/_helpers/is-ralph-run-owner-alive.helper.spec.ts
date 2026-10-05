import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRalphRunOwnerAlive } from "./is-ralph-run-owner-alive.helper.js";

afterEach(() => vi.restoreAllMocks());

describe("RALPH run owner liveness", () => {
  it("retains the current process owner", () => {
    const kill = vi.spyOn(process, "kill");
    expect(isRalphRunOwnerAlive(`${process.pid}:${randomUUID()}`)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });

  it("recognizes a confirmed dead process owner", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    expect(isRalphRunOwnerAlive(`12345:${randomUUID()}`)).toBe(false);
  });

  it("retains a live process owner", () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    expect(isRalphRunOwnerAlive(`12345:${randomUUID()}`)).toBe(true);
  });

  it.each(["EPERM", "EACCES", undefined])(
    "retains ownership when the process check is inconclusive (%s)",
    (code) => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("Cannot inspect process"), { code });
      });
      expect(isRalphRunOwnerAlive(`12345:${randomUUID()}`)).toBe(true);
    },
  );

  it.each([
    "owner",
    "0:owner",
    `4294967296:${randomUUID()}`,
    `9007199254740993:${randomUUID()}`,
  ])("does not assume an uninspectable owner is dead (%s)", (owner) => {
    const kill = vi.spyOn(process, "kill");
    expect(isRalphRunOwnerAlive(owner)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });
});
