import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProductSession } from "@machdoch/fleet-protocol";
import type { SessionIndexQuery } from "@machdoch/fleet-protocol/session-data";
import { useSessionIndex } from "./use-session-index";

afterEach(cleanup);
const session = (id: string) => ({ id }) as ProductSession;
const page = (start: number, end: number, total = 100) => ({
  sessions: Array.from({ length: end - start }, (_, index) =>
    session(`${start + index}`),
  ),
  total,
  nextOffset: end < total ? end : null,
  sessionIds: Array.from({ length: total }, (_, index) => `${index}`),
  projects: [],
  tags: [],
  statuses: [],
});
const query: SessionIndexQuery = {
  offset: 0,
  limit: 80,
  query: "",
  scope: "all",
  statuses: [],
  project: "__all_projects__",
  tags: [],
};

it("keeps every loaded session page when the live snapshot refreshes", async () => {
  const index = vi
    .fn()
    .mockImplementation(async (args: SessionIndexQuery) =>
      args.offset === 0 ? page(0, 80) : page(80, 100),
    );
  const source = { index, export: vi.fn(), import: vi.fn() };
  const { result, rerender } = renderHook(
    (identity) => useSessionIndex(source, query, identity),
    { initialProps: "first" },
  );
  await waitFor(() => expect(result.current.page?.sessions).toHaveLength(80));
  await act(async () => {
    await result.current.loadEarlier();
  });
  expect(result.current.page?.sessions).toHaveLength(100);
  rerender("changed");
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.page?.sessions).toHaveLength(100);
  expect(index.mock.calls.map(([args]) => args.offset)).toEqual([
    0, 0, 80, 0, 80,
  ]);
});

it("ignores an earlier query that resolves after a newer query", async () => {
  let resolveFirst!: (value: unknown) => void;
  const index = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValueOnce(page(89, 90, 90));
  const source = { index, export: vi.fn(), import: vi.fn() };
  const { result, rerender } = renderHook(
    (value) => useSessionIndex(source, value, "snapshot"),
    { initialProps: query },
  );
  rerender({ ...query, query: "hidden transcript" });
  await waitFor(() => expect(result.current.page?.sessions[0]?.id).toBe("89"));
  await act(async () => {
    resolveFirst(page(0, 80));
  });
  expect(result.current.page?.sessions[0]?.id).toBe("89");
});
