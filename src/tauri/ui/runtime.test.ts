import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableInvokeMock,
  enableInvokeMock,
  invokeMock,
  isTauriMock,
} from "./test/tauri-test-mocks";
import {
  cancelDesktopTask,
  detectFullscreenWindowOnMonitor,
  loadActiveDesktopTaskIds,
  loadDesktopLaunchId,
  resolveDroppedPaths,
  runDesktopTask,
} from "./runtime";

describe("desktop runtime fullscreen detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableInvokeMock();
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue(false);
  });

  afterEach(() => {
    disableInvokeMock();
  });

  it("passes monitor bounds under the Rust command's monitor parameter", async () => {
    const monitor = { x: 0, y: 0, width: 1920, height: 1080 };

    invokeMock.mockResolvedValueOnce(true);

    await expect(detectFullscreenWindowOnMonitor(monitor)).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "detect_fullscreen_window_on_monitor",
      { monitor },
    );
  });

  it("falls back to visible when Tauri commands are unavailable", async () => {
    disableInvokeMock();

    await expect(
      detectFullscreenWindowOnMonitor({ x: 0, y: 0, width: 1920, height: 1080 }),
    ).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("loads the desktop launch ID through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce("launch-123");

    await expect(loadDesktopLaunchId()).resolves.toBe("launch-123");
    expect(invokeMock).toHaveBeenCalledWith("get_desktop_launch_id");
  });

  it("loads active desktop task IDs through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce(["task-2", "task-1"]);

    await expect(loadActiveDesktopTaskIds()).resolves.toEqual([
      "task-2",
      "task-1",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("get_active_desktop_task_ids");
  });

  it("returns no active desktop task snapshot when Tauri commands are unavailable", async () => {
    disableInvokeMock();

    await expect(loadActiveDesktopTaskIds()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("resolves dropped paths through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce({
      workspaceRoot: "C:\\Docs",
      entries: [
        {
          path: "C:\\Docs\\notes.md",
          kind: "file",
          name: "notes.md",
          parent: "C:\\Docs",
        },
      ],
    });

    await expect(resolveDroppedPaths([" C:\\Docs\\notes.md "])).resolves.toEqual({
      workspaceRoot: "C:\\Docs",
      entries: [
        {
          path: "C:\\Docs\\notes.md",
          kind: "file",
          name: "notes.md",
          parent: "C:\\Docs",
        },
      ],
    });
    expect(invokeMock).toHaveBeenCalledWith("resolve_dropped_paths", {
      paths: ["C:\\Docs\\notes.md"],
    });
  });

  it("passes desktop task runs under the Rust command's request parameter", async () => {
    invokeMock.mockResolvedValueOnce({
      execution: {
        task: "Inspect notes",
        workspaceRoot: "C:\\Docs",
        mode: "ask",
        status: "executed",
        summary: "Done.",
      },
    });

    await runDesktopTask(" C:\\Docs ", " Inspect notes ", {
      mode: "ask",
      taskId: "task-123",
    });

    expect(invokeMock).toHaveBeenCalledWith("run_desktop_task", {
      request: {
        workspaceRoot: "C:\\Docs",
        task: "Inspect notes",
        mode: "ask",
        taskId: "task-123",
      },
    });
  });

  it("passes desktop task cancellation through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await cancelDesktopTask("task-123");

    expect(invokeMock).toHaveBeenCalledWith("cancel_desktop_task", {
      taskId: "task-123",
    });
  });
});
