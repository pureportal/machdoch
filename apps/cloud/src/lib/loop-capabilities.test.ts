import { describe, expect, it } from "vitest";
import { checkLoopCapabilities } from "./loop-capabilities";

const allCode = { mode: "all" as const, repositoryIds: [] };

describe("loop capabilities", () => {
  it("rejects a capability the chosen executor lacks", () => {
    expect(
      checkLoopCapabilities({
        placement: "sandbox",
        required: ["desktop"],
        repositoryIds: [],
        codeAccess: allCode,
      }),
    ).toEqual({ available: false, reason: "Cloud sandbox has no desktop." });
    expect(
      checkLoopCapabilities({
        placement: "client",
        required: ["desktop", "local_files"],
        repositoryIds: [],
        codeAccess: allCode,
      }),
    ).toEqual({ available: true, placement: "client" });
  });

  it("chooses an executor automatically by required capability", () => {
    expect(
      checkLoopCapabilities({
        placement: "automatic",
        required: ["repository", "shell"],
        repositoryIds: [],
        codeAccess: allCode,
      }),
    ).toEqual({ available: true, placement: "sandbox" });
    expect(
      checkLoopCapabilities({
        placement: "automatic",
        required: ["gpu"],
        repositoryIds: [],
        codeAccess: allCode,
      }),
    ).toEqual({ available: true, placement: "runner_pool" });
    expect(
      checkLoopCapabilities({
        placement: "automatic",
        required: ["gpu", "desktop"],
        repositoryIds: [],
        codeAccess: allCode,
      }),
    ).toMatchObject({ available: false });
  });

  it("enforces the workspace code-access setting", () => {
    const selected = { mode: "selected" as const, repositoryIds: ["repo-a"] };
    expect(
      checkLoopCapabilities({
        placement: "automatic",
        required: ["repository"],
        repositoryIds: ["repo-a"],
        codeAccess: selected,
      }),
    ).toMatchObject({ available: true });
    expect(
      checkLoopCapabilities({
        placement: "automatic",
        required: ["repository"],
        repositoryIds: ["repo-b"],
        codeAccess: selected,
      }),
    ).toEqual({
      available: false,
      reason: "Loops may not access this repository.",
    });
    expect(
      checkLoopCapabilities({
        placement: "sandbox",
        required: ["repository"],
        repositoryIds: [],
        codeAccess: { mode: "selected", repositoryIds: [] },
      }),
    ).toEqual({ available: false, reason: "Loops may not access code." });
  });
});
