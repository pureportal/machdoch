// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMediaModelLibraryRefresh } from "./use-media-model-library-refresh";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes catalog and folder discovery automatically and on focus", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const catalog = vi.fn(async () => null);
  const discovery = vi.fn(async () => undefined);
  const view = renderHook(() =>
    useMediaModelLibraryRefresh(catalog, discovery),
  );
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(catalog).toHaveBeenCalledTimes(1);
  expect(discovery).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(catalog).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  window.dispatchEvent(new Event("focus"));
  expect(catalog).toHaveBeenCalledTimes(2);
});

it("suspends background scans and refreshes when the application becomes visible", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const catalog = vi.fn(async () => null);
  const discovery = vi.fn(async () => undefined);
  const view = renderHook(() =>
    useMediaModelLibraryRefresh(catalog, discovery),
  );
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(discovery).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(discovery).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("waits for a slow scan before starting another refresh", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  let finish: (() => void) | undefined;
  const catalog = vi.fn(async () => null);
  const discovery = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = renderHook(() =>
    useMediaModelLibraryRefresh(catalog, discovery),
  );
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  window.dispatchEvent(new Event("focus"));
  expect(discovery).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish?.();
  });
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(discovery).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish?.();
  });
  view.unmount();
});
