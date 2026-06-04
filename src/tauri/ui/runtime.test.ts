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
  loadProviderModelCatalog,
  loadUserReviewModelSettings,
  resolveDroppedPaths,
  runDesktopTask,
  saveClipboardImageAttachment,
  saveUserReviewModelSettings,
  saveUserSpeechToTextInputDevice,
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

  it("loads the provider model catalog through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce({
      generatedAt: 123,
      providers: [
        {
          provider: "openai",
          source: "provider-api",
          available: true,
          models: [],
        },
      ],
    });

    await expect(loadProviderModelCatalog()).resolves.toMatchObject({
      generatedAt: 123,
      providers: [
        {
          provider: "openai",
          available: true,
        },
      ],
    });
    expect(invokeMock).toHaveBeenCalledWith("get_provider_model_catalog");
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

  it("saves clipboard image attachments through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce("C:\\Temp\\clipboard-image.png");

    await expect(
      saveClipboardImageAttachment({
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
        mediaType: "image/png",
        fileName: "clipboard-image.png",
      }),
    ).resolves.toBe("C:\\Temp\\clipboard-image.png");

    expect(invokeMock).toHaveBeenCalledWith("save_clipboard_image_attachment", {
      request: {
        dataBase64: "AQID",
        mediaType: "image/png",
        fileName: "clipboard-image.png",
      },
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
      imagePaths: [" C:\\Docs\\screen.png "],
      mode: "ask",
      taskId: "task-123",
    });

    expect(invokeMock).toHaveBeenCalledWith("run_desktop_task", {
      request: {
        workspaceRoot: "C:\\Docs",
        task: "Inspect notes",
        imagePaths: ["C:\\Docs\\screen.png"],
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

  it("saves the speech input device through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce({
      activeProvider: "openai",
      inputDeviceId: "mic-2",
      providerAvailability: [],
    });

    await expect(saveUserSpeechToTextInputDevice(" mic-2 ")).resolves.toEqual({
      activeProvider: "openai",
      inputDeviceId: "mic-2",
      providerAvailability: [],
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "save_user_speech_to_text_input_device",
      { inputDeviceId: "mic-2" },
    );
  });

  it("loads review model settings through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce({
      mode: "dedicated",
      provider: "google",
      model: "gemini-2.5-flash-lite",
    });

    await expect(loadUserReviewModelSettings()).resolves.toEqual({
      mode: "dedicated",
      provider: "google",
      model: "gemini-2.5-flash-lite",
    });
    expect(invokeMock).toHaveBeenCalledWith("get_user_review_model_settings");
  });

  it("saves normalized review model settings through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce({
      mode: "dedicated",
      provider: "openai",
      model: "gpt-5.4-mini",
    });

    await expect(
      saveUserReviewModelSettings({
        mode: "dedicated",
        provider: "openai",
        model: " gpt-5.4-mini ",
      }),
    ).resolves.toEqual({
      mode: "dedicated",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "save_user_review_model_settings",
      {
        settings: {
          mode: "dedicated",
          provider: "openai",
          model: "gpt-5.4-mini",
        },
      },
    );
  });

  it("falls back to base review model settings when a dedicated model is incomplete", async () => {
    disableInvokeMock();

    await expect(
      saveUserReviewModelSettings({
        mode: "dedicated",
        provider: "openai",
      }),
    ).resolves.toEqual({
      mode: "base",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
