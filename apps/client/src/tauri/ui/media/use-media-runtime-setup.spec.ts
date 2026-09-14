// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_MEDIA_RUNTIME_SETUP,
  type MediaRuntimeSetupStatus,
} from "./media-runtime-setup";
import { useMediaRuntimeSetup } from "./use-media-runtime-setup";

const api = vi.hoisted(() => ({ get: vi.fn(), start: vi.fn() }));
vi.mock("./media-runtime-setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-runtime-setup")>()),
  getMediaRuntimeSetup: api.get,
  startMediaRuntimeSetup: api.start,
}));

const status = (
  phase: MediaRuntimeSetupStatus["phase"],
): MediaRuntimeSetupStatus => ({ ...EMPTY_MEDIA_RUNTIME_SETUP, phase });

beforeEach(() => {
  api.get.mockReset().mockResolvedValue(status("idle"));
  api.start.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Media Studio setup", () => {
  it("starts once, follows progress, and refreshes model actions when verified", async () => {
    const ready = vi.fn(async () => undefined);
    let completeStart!: (value: MediaRuntimeSetupStatus) => void;
    api.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeStart = resolve;
        }),
    );
    const { result } = renderHook(() => useMediaRuntimeSetup(ready));
    await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    act(() => {
      void result.current.start();
      void result.current.start();
    });
    expect(api.start).toHaveBeenCalledOnce();
    await act(async () => {
      completeStart(status("checking"));
    });
    api.get.mockResolvedValue(status("dependencies"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.status.phase).toBe("dependencies");
    expect(ready).not.toHaveBeenCalled();
    api.get.mockResolvedValue(status("ready"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.status.phase).toBe("ready");
    expect(ready).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(ready).toHaveBeenCalledOnce();
  });

  it("reconnects to setup after returning to Media Studio", async () => {
    api.get.mockResolvedValue(status("verifying"));
    const ready = vi.fn(async () => undefined);
    const first = renderHook(() => useMediaRuntimeSetup(ready));
    await waitFor(() =>
      expect(first.result.current.status.phase).toBe("verifying"),
    );
    first.unmount();
    api.get.mockResolvedValue(status("ready"));
    renderHook(() => useMediaRuntimeSetup(ready));
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(api.start).not.toHaveBeenCalled();
  });

  it("keeps a start failure visible and retries the same setup action", async () => {
    const ready = vi.fn(async () => undefined);
    api.start
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockResolvedValueOnce(status("ready"));
    const { result } = renderHook(() => useMediaRuntimeSetup(ready));
    await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status.phase).toBe("failed");
    expect(result.current.status.message).toBe(
      "Setup could not start. Retry setup.",
    );
    expect(ready).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.start();
    });
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(ready).toHaveBeenCalledOnce();
  });

  it("does not report setup failure when refreshing models fails", async () => {
    const ready = vi
      .fn()
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce(undefined);
    api.get.mockResolvedValue(status("ready"));
    const { result } = renderHook(() => useMediaRuntimeSetup(ready));
    await waitFor(() => expect(result.current.refreshFailed).toBe(true));
    expect(result.current.status.phase).toBe("ready");
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.refreshFailed).toBe(false);
    expect(api.start).not.toHaveBeenCalled();
  });

  it("clears a connection warning when setup responds successfully", async () => {
    api.get.mockRejectedValue(new Error("connection closed"));
    api.start.mockResolvedValue(status("ready"));
    const ready = vi.fn(async () => undefined);
    const { result } = renderHook(() => useMediaRuntimeSetup(ready));
    await waitFor(() => expect(result.current.statusUnavailable).toBe(true));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status.phase).toBe("ready");
    expect(result.current.statusUnavailable).toBe(false);
    expect(ready).toHaveBeenCalledOnce();
  });
});
