// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_FOR_UPDATES_EVENT,
  useDesktopUpdate,
} from "./use-desktop-update";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = mocks.get;
    set = mocks.set;
    save = mocks.save;
  },
}));

function availableUpdate() {
  return {
    currentVersion: "1.0.0",
    version: "2.0.0",
    rawJson: {
      version: "2.0.0",
      platforms: {
        "linux-headless": {
          url: "https://github.com/pureportal/machdoch/releases/download/v2.0.0/machdoch-headless.tar.gz",
          signature: "signature",
          sha256: "0".repeat(64),
          size: 100,
        },
      },
    },
    download: mocks.download,
    install: mocks.install,
    close: mocks.close,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.invoke.mockResolvedValue(true);
  mocks.check.mockResolvedValue(availableUpdate());
  mocks.get.mockResolvedValue(null);
  for (const operation of [
    mocks.set,
    mocks.save,
    mocks.download,
    mocks.install,
    mocks.close,
    mocks.relaunch,
  ])
    operation.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("desktop update lifecycle", () => {
  it("respects a skipped release and allows a manual check to bypass it", async () => {
    mocks.get.mockResolvedValue({ skippedVersion: "2.0.0" });
    const { result } = renderHook(() =>
      useDesktopUpdate({ busy: false, flush: async () => {} }),
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    expect(result.current.open).toBe(false);
    act(() => {
      window.dispatchEvent(new Event(CHECK_FOR_UPDATES_EVENT));
    });
    await waitFor(() => expect(result.current.open).toBe(true));
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("persists reminders and keeps the dialog open if saving fails", async () => {
    const { result } = renderHook(() =>
      useDesktopUpdate({ busy: false, flush: async () => {} }),
    );
    await waitFor(() => expect(result.current.open).toBe(true));
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      await result.current.defer("release");
    });
    expect(result.current.open).toBe(true);
    expect(result.current.error).toMatch(/disk full/);
    await act(async () => {
      await result.current.defer("release");
    });
    expect(mocks.set).toHaveBeenLastCalledWith("notification", {
      skippedVersion: "2.0.0",
    });
    expect(result.current.open).toBe(false);
  });

  it("blocks installation while work is active", async () => {
    const { result } = renderHook(() =>
      useDesktopUpdate({ busy: true, flush: async () => {} }),
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    await act(async () => {
      await result.current.install();
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/running work/);
  });

  it("rechecks activity after downloading and releases the installation lock on failure", async () => {
    let downloaded: (() => void) | undefined;
    mocks.download.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          downloaded = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ busy }) => useDesktopUpdate({ busy, flush: async () => {} }),
      { initialProps: { busy: false } },
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    let installing: Promise<void> | undefined;
    act(() => {
      installing = result.current.install();
    });
    await waitFor(() => expect(mocks.download).toHaveBeenCalled());
    rerender({ busy: true });
    await act(async () => {
      downloaded?.();
      await installing;
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("finish_app_update");
    expect(result.current.error).toMatch(/Work started/);
  });

  it("keeps an installed update distinct from a restart failure", async () => {
    mocks.relaunch.mockRejectedValueOnce(new Error("restart failed"));
    const flush = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useDesktopUpdate({ busy: false, flush }),
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    await act(async () => {
      await result.current.install();
    });
    expect(result.current.phase).toBe("installed");
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(2);
    await act(async () => {
      await result.current.install();
    });
    await act(async () => {
      await result.current.restart();
    });
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).toHaveBeenCalledTimes(2);
  });

  it("allows a manual check when reminder storage cannot be read", async () => {
    mocks.get.mockRejectedValueOnce(new Error("storage unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useDesktopUpdate({ busy: false, flush: async () => {} }),
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new Event(CHECK_FOR_UPDATES_EVENT));
    });
    await waitFor(() => expect(result.current.phase).toBe("available"));
    expect(result.current.open).toBe(true);
  });
});
