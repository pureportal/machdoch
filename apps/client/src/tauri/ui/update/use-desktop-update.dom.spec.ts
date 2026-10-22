// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@tauri-apps/api/core";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
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
  cancel: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
  Channel: class {
    onmessage = vi.fn();
  },
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

function availableUpdate(version = "2.0.0") {
  return {
    rid: 1,
    currentVersion: "1.0.0",
    version,
    rawJson: {
      version,
      platforms: {
        "linux-headless": {
          url: `https://github.com/pureportal/machdoch/releases/download/v${version}/machdoch-headless.tar.gz`,
          signature: btoa(
            `untrusted comment: test\npacket\ntrusted comment: timestamp:1\tfile:machdoch-headless.tar.gz\tversion:${version}\nglobal\n`,
          ),
          sha256: "0".repeat(64),
          size: 100,
        },
      },
    },
    close: mocks.close,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.invoke.mockImplementation((command, args) => {
    if (command === "download_app_update") return mocks.download(args.onEvent);
    if (command === "install_app_update") return mocks.install(args.rid);
    if (command === "cancel_app_update_download") return mocks.cancel();
    return Promise.resolve(true);
  });
  mocks.check.mockResolvedValue(availableUpdate());
  mocks.get.mockResolvedValue(null);
  for (const operation of [
    mocks.set,
    mocks.save,
    mocks.install,
    mocks.cancel,
    mocks.close,
    mocks.relaunch,
  ])
    operation.mockResolvedValue(undefined);
  mocks.download.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("desktop update lifecycle", () => {
  it("respects a skipped release and allows a manual check to bypass it", async () => {
    mocks.get.mockResolvedValue({ skippedVersion: "2.0.0" });
    const { result } = renderHook(() =>
      useDesktopUpdate({ flush: async () => {} }),
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
      useDesktopUpdate({ flush: async () => {} }),
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

  it.each(["timer", "resume"])(
    "refreshes an expired reminder before reopening it on %s",
    async (trigger) => {
      vi.useFakeTimers();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const { result } = renderHook(() =>
        useDesktopUpdate({ flush: async () => {} }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.release?.version).toBe("2.0.0");
      await act(async () => {
        await result.current.defer("hour");
        await vi.advanceTimersByTimeAsync(59 * 60_000);
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(result.current.open).toBe(false);
      expect(mocks.check).toHaveBeenCalledOnce();

      let checked: (value: ReturnType<typeof availableUpdate>) => void = () => {};
      mocks.check.mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof availableUpdate>>((resolve) => {
            checked = resolve;
          }),
      );
      await act(async () => {
        if (trigger === "timer") await vi.advanceTimersByTimeAsync(60_000);
        else {
          vi.setSystemTime(Date.now() + 60_000);
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      expect(mocks.check).toHaveBeenCalledTimes(2);
      expect(result.current.open).toBe(false);
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.check).toHaveBeenCalledTimes(2);

      await act(async () => {
        checked(availableUpdate("3.0.0"));
      });
      expect(result.current.open).toBe(true);
      expect(result.current.release?.version).toBe("3.0.0");
      expect(mocks.close).toHaveBeenCalledOnce();
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mocks.check).toHaveBeenCalledTimes(2);
    },
  );

  it("does not reopen a cached offer when the update is no longer available", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useDesktopUpdate({ flush: async () => {} }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await result.current.defer("hour");
    });
    mocks.check.mockResolvedValueOnce(null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(result.current.open).toBe(false);
    expect(result.current.release).toBeNull();
    expect(result.current.phase).toBe("current");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("retries a failed reminder check without reopening the cached offer", async () => {
    vi.useFakeTimers();
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useDesktopUpdate({ flush: async () => {} }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await result.current.defer("hour");
    });
    mocks.check.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(result.current.open).toBe(false);
    expect(logError).toHaveBeenCalledWith(
      "Could not check for updates",
      expect.objectContaining({ message: "offline" }),
    );
    mocks.check.mockResolvedValueOnce(availableUpdate("3.0.0"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.check).toHaveBeenCalledTimes(3);
    expect(result.current.open).toBe(true);
    expect(result.current.release?.version).toBe("3.0.0");
  });

  it("downloads, installs, and restarts after saving pending changes", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useDesktopUpdate({ flush }));
    await waitFor(() => expect(result.current.phase).toBe("available"));
    await act(async () => {
      await result.current.install();
    });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.download.mock.invocationCallOrder[0]!,
    );
    expect(flush.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.install.mock.invocationCallOrder[0]!,
    );
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("installed");
    expect(result.current.error).toBeNull();
  });

  it("saves changes made during the download before installing", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const flushAfterDownload = vi.fn().mockResolvedValue(undefined);
    let downloaded: ((value: boolean) => void) | undefined;
    mocks.download.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          downloaded = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      (options) => useDesktopUpdate(options),
      { initialProps: { flush } },
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    let installing: Promise<void> | undefined;
    act(() => {
      installing = result.current.install();
    });
    await waitFor(() => expect(mocks.download).toHaveBeenCalled());
    rerender({ flush: flushAfterDownload });
    await act(async () => {
      downloaded?.(true);
      await installing;
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(flushAfterDownload).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("finish_app_update");
    expect(result.current.error).toBeNull();
  });

  it("releases the installation lock when downloading fails", async () => {
    mocks.download.mockRejectedValueOnce(new Error("download failed"));
    const { result } = renderHook(() =>
      useDesktopUpdate({ flush: async () => {} }),
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    await act(async () => {
      await result.current.install();
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("finish_app_update");
    expect(result.current.phase).toBe("available");
    expect(result.current.error).toBe("download failed");
  });

  it("keeps an installed update distinct from a restart failure", async () => {
    mocks.relaunch.mockRejectedValueOnce(new Error("restart failed"));
    const flush = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useDesktopUpdate({ flush }));
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
      useDesktopUpdate({ flush: async () => {} }),
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new Event(CHECK_FOR_UPDATES_EVENT));
    });
    await waitFor(() => expect(result.current.phase).toBe("available"));
    expect(result.current.open).toBe(true);
  });

  it("keeps a hidden download running through reminders and reopens it without another check", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    let downloaded: (value: boolean) => void = () => {};
    mocks.download.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          downloaded = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useDesktopUpdate({ flush: async () => {} }),
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    let installing: Promise<void> | undefined;
    act(() => {
      installing = result.current.install();
    });
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    const channel = mocks.download.mock.calls[0]![0] as Channel<DownloadEvent>;
    act(() => {
      channel.onmessage({ event: "Started", data: { contentLength: 100 } });
      channel.onmessage({ event: "Progress", data: { chunkLength: 25 } });
      result.current.hide();
    });
    expect(result.current.progress).toEqual({ downloaded: 25, total: 100 });
    expect(result.current.open).toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
    act(() => {
      const reminder = intervals.mock.calls.find(
        ([, delay]) => delay === 60_000,
      )?.[0];
      if (typeof reminder !== "function")
        throw new Error("Update reminder was not scheduled");
      reminder();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.open).toBe(false);
    act(() => window.dispatchEvent(new Event(CHECK_FOR_UPDATES_EVENT)));
    expect(result.current.open).toBe(true);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(async () => {
      downloaded(true);
      await installing;
    });
    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it("cancels a download, ignores late progress and completion, and allows a fresh attempt", async () => {
    let downloaded: (value: boolean) => void = () => {};
    mocks.download.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          downloaded = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useDesktopUpdate({ flush: async () => {} }),
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    let installing: Promise<void> | undefined;
    act(() => {
      installing = result.current.install();
    });
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    const channel = mocks.download.mock.calls[0]![0] as Channel<DownloadEvent>;
    await act(async () => {
      await result.current.cancel();
    });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(result.current.canceling).toBe(true);
    await act(async () => {
      channel.onmessage({ event: "Progress", data: { chunkLength: 100 } });
      downloaded(true);
      await installing;
    });
    expect(result.current.phase).toBe("available");
    expect(result.current.canceling).toBe(false);
    expect(result.current.progress).toEqual({ downloaded: 0 });
    expect(result.current.error).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("finish_app_update");
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.install();
    });
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it("can cancel while saving changes before a download starts", async () => {
    let saved: () => void = () => {};
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    const { result } = renderHook(() => useDesktopUpdate({ flush }));
    await waitFor(() => expect(result.current.phase).toBe("available"));
    let installing: Promise<void> | undefined;
    act(() => {
      installing = result.current.install();
    });
    await act(async () => {
      await result.current.cancel();
      saved();
      await installing;
    });
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("available");
  });

  it("does not install if cancellation happens while saving changes after downloading", async () => {
    let saved: () => void = () => {};
    const flush = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            saved = resolve;
          }),
      );
    const { result } = renderHook(() => useDesktopUpdate({ flush }));
    await waitFor(() => expect(result.current.phase).toBe("available"));
    let installing: Promise<void> | undefined;
    act(() => {
      installing = result.current.install();
    });
    await waitFor(() => expect(flush).toHaveBeenCalledTimes(2));
    await act(async () => {
      await result.current.cancel();
      saved();
      await installing;
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("available");
  });

  it("reopens a hidden dialog when downloading fails", async () => {
    let failed: (error: Error) => void = () => {};
    mocks.download.mockImplementationOnce(
      () =>
        new Promise<boolean>((_, reject) => {
          failed = reject;
        }),
    );
    const { result } = renderHook(() =>
      useDesktopUpdate({ flush: async () => {} }),
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    let installing: Promise<void> | undefined;
    act(() => {
      installing = result.current.install();
    });
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    act(() => result.current.hide());
    await act(async () => {
      failed(new Error("Connection lost"));
      await installing;
    });
    expect(result.current.open).toBe(true);
    expect(result.current.error).toBe("Connection lost");
  });

  it("cancels and releases the update when the shell unmounts during a download", async () => {
    let downloaded: (value: boolean) => void = () => {};
    mocks.download.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          downloaded = resolve;
        }),
    );
    const { result, unmount } = renderHook(() =>
      useDesktopUpdate({ flush: async () => {} }),
    );
    await waitFor(() => expect(result.current.phase).toBe("available"));
    let installing: Promise<void> | undefined;
    act(() => {
      installing = result.current.install();
    });
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    unmount();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    await act(async () => {
      downloaded(true);
      await installing;
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("finish_app_update");
  });
});
