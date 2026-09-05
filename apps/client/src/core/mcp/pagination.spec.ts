import { describe, expect, it, vi } from "vitest";
import { collectMcpPages } from "./pagination.js";

describe("bounded MCP discovery", () => {
  it("preserves page order and passes cursors to subsequent requests", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [1, 2], nextCursor: "second" })
      .mockResolvedValueOnce({ items: [3] });
    await expect(collectMcpPages(load)).resolves.toEqual([1, 2, 3]);
    expect(load.mock.calls).toEqual([[undefined], ["second"]]);
  });

  it("stops an alternating cursor cycle without fetching again", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: "a" })
      .mockResolvedValueOnce({ items: [], nextCursor: "b" })
      .mockResolvedValue({ items: [], nextCursor: "a" });
    await expect(collectMcpPages(load)).rejects.toThrow(
      "repeated pagination cursor",
    );
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("bounds endless unique empty pages", async () => {
    let page = 0;
    const load = vi.fn(async () => ({ items: [], nextCursor: String(++page) }));
    await expect(collectMcpPages(load)).rejects.toThrow("100 pages");
    expect(load).toHaveBeenCalledTimes(100);
  });

  it("bounds the aggregate entry count", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        items: Array(6_000).fill(0),
        nextCursor: "next",
      })
      .mockResolvedValue({ items: Array(6_000).fill(0) });
    await expect(collectMcpPages(load)).rejects.toThrow("10,000 entries");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds serialized metadata even when there are few entries", async () => {
    const load = vi.fn(async () => ({ items: ["x".repeat(16 * 1024 * 1024)] }));
    await expect(collectMcpPages(load)).rejects.toThrow("16 MB");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
