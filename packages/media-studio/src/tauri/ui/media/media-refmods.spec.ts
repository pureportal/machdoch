import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "./media-platform";
import { refModOperation } from "./media-refmods";

vi.mock("./media-platform", () => ({ invoke: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe("RefMod collection pagination", () => {
  it("shows the runtime installation recovery from a native RefMod failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({
      code: "RUNTIME_NOT_INSTALLED",
      category: "configuration",
      message: "Install the Media Studio runtime, then try again.",
      retryability: "after-user-action",
    });
    await expect(
      refModOperation("workspace", { operation: "list" }),
    ).rejects.toThrow("Install the Media Studio runtime, then try again.");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("collects batch results and file errors in order", async () => {
    const first = { path: "first", record: { tokens: 4 } };
    const failed = { path: "failed", error: "Invalid file" };
    const last = { path: "last", record: { tokens: 8 } };
    vi.mocked(invoke)
      .mockResolvedValueOnce({ records: [first, failed], nextOffset: 2 })
      .mockResolvedValueOnce({ records: [last], nextOffset: null });
    const request = {
      operation: "inspect-many",
      paths: ["first", "failed", "last"],
    };
    await expect(refModOperation("workspace", request)).resolves.toEqual([
      first,
      failed,
      last,
    ]);
    expect(invoke).toHaveBeenNthCalledWith(1, "media_refmod_operation", {
      workspaceRoot: "workspace",
      request: { ...request, offset: 0 },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "media_refmod_operation", {
      workspaceRoot: "workspace",
      request: { ...request, offset: 2 },
    });
  });

  it("collects library entries and errors across pages", async () => {
    const first = { path: "first", name: "First", tokens: 4 };
    const last = { path: "last", name: "Last", tokens: 8 };
    const error = { path: "failed", error: "Invalid file" };
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        records: [first],
        errors: [error],
        nextOffset: 2,
      })
      .mockResolvedValueOnce({ records: [last], errors: [], nextOffset: null });
    await expect(
      refModOperation("workspace", { operation: "list", directory: "library" }),
    ).resolves.toEqual({ records: [first, last], errors: [error] });
  });

  it.each([0, -1, 257, 1.5, undefined])(
    "rejects invalid batch cursor %s",
    async (nextOffset) => {
      vi.mocked(invoke).mockResolvedValueOnce({ records: [], nextOffset });
      await expect(
        refModOperation("workspace", {
          operation: "inspect-many",
          paths: ["first"],
        }),
      ).rejects.toThrow("Could not finish reading RefMods");
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a cursor that stops advancing", async () => {
    vi.mocked(invoke).mockResolvedValue({ records: [], nextOffset: 1 });
    await expect(
      refModOperation("workspace", {
        operation: "inspect-many",
        paths: ["first", "last"],
      }),
    ).rejects.toThrow("Could not finish reading RefMods");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    { records: "invalid", errors: [], nextOffset: null },
    { records: [], nextOffset: null },
  ])("rejects malformed library page %s", async (page) => {
    vi.mocked(invoke).mockResolvedValueOnce(page);
    await expect(
      refModOperation("workspace", { operation: "list", directory: "library" }),
    ).rejects.toThrow("Could not finish reading RefMods");
  });
});
