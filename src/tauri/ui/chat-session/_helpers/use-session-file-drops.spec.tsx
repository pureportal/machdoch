import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopEventListeners,
  windowDragDropListeners,
} from "../../test/tauri-test-mocks";
import { useSessionFileDrops } from "./use-session-file-drops";

const createDataTransfer = (
  data: Record<string, string>,
  files: File[] = [],
): DataTransfer =>
  ({
    types: Object.keys(data),
    files,
    dropEffect: "none",
    getData: vi.fn((type: string) => data[type] ?? ""),
  }) as unknown as DataTransfer;

const dispatchDrop = (dataTransfer: DataTransfer): void => {
  const event = new Event("drop", {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;

  Object.defineProperty(event, "dataTransfer", {
    value: dataTransfer,
  });

  window.dispatchEvent(event);
};

describe("useSessionFileDrops", () => {
  beforeEach(() => {
    desktopEventListeners.clear();
    windowDragDropListeners.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    desktopEventListeners.clear();
    windowDragDropListeners.clear();
  });

  it("logs dropped-file attachment failures instead of leaking unhandled rejections", async () => {
    const error = new Error("resolve failed");
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const onAttachPaths = vi.fn().mockRejectedValue(error);

    renderHook(() =>
      useSessionFileDrops({
        fileDropTarget: "active-session",
        isDesktop: true,
        onAttachPaths,
      }),
    );

    await waitFor(() => expect(windowDragDropListeners.size).toBe(1));

    const [listener] = windowDragDropListeners;

    act(() => {
      listener({
        payload: {
          type: "drop",
          paths: ["C:\\workspace\\report.md"],
          position: { x: 12, y: 34 },
        },
      });
    });

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Failed to attach dropped files",
        error,
      );
    });
  });

  it("attaches browser-dropped URLs as references", async () => {
    const onAttachPaths = vi.fn().mockResolvedValue(undefined);
    const onAttachReferences = vi.fn();

    renderHook(() =>
      useSessionFileDrops({
        fileDropTarget: "active-session",
        isDesktop: false,
        onAttachPaths,
        onAttachReferences,
      }),
    );

    act(() => {
      dispatchDrop(
        createDataTransfer({
          "text/uri-list": "https://example.com/docs\n# ignored",
          "text/plain": "https://example.com/docs",
        }),
      );
    });

    await waitFor(() => {
      expect(onAttachReferences).toHaveBeenCalledWith(
        ["https://example.com/docs"],
        "active-session",
      );
    });
    expect(onAttachPaths).not.toHaveBeenCalled();
  });

  it("appends browser-dropped plain text", async () => {
    const onAppendText = vi.fn();

    renderHook(() =>
      useSessionFileDrops({
        fileDropTarget: "quick-task",
        isDesktop: false,
        onAttachPaths: vi.fn().mockResolvedValue(undefined),
        onAppendText,
      }),
    );

    act(() => {
      dispatchDrop(
        createDataTransfer({
          "text/plain": "Summarize this selected paragraph.",
        }),
      );
    });

    await waitFor(() => {
      expect(onAppendText).toHaveBeenCalledWith(
        "Summarize this selected paragraph.",
        "quick-task",
      );
    });
  });

  it("accepts forwarded drop payloads from another window", async () => {
    const onAttachPaths = vi.fn().mockResolvedValue(undefined);
    const onAttachReferences = vi.fn();
    const onAppendText = vi.fn();

    renderHook(() =>
      useSessionFileDrops({
        fileDropTarget: "quick-task",
        isDesktop: true,
        onAttachPaths,
        onAttachReferences,
        onAppendText,
        forwardedDropEventName: "machdoch://quick-chat-drop",
      }),
    );

    await waitFor(() => {
      expect(desktopEventListeners.has("machdoch://quick-chat-drop")).toBe(true);
    });

    act(() => {
      desktopEventListeners.get("machdoch://quick-chat-drop")?.({
        payload: {
          paths: ["C:\\Docs\\quick-note.txt"],
          references: ["https://example.com"],
          text: "Dropped prompt text",
        },
      });
    });

    await waitFor(() => {
      expect(onAttachPaths).toHaveBeenCalledWith(
        ["C:\\Docs\\quick-note.txt"],
        "quick-task",
      );
      expect(onAttachReferences).toHaveBeenCalledWith(
        ["https://example.com"],
        "quick-task",
      );
      expect(onAppendText).toHaveBeenCalledWith(
        "Dropped prompt text",
        "quick-task",
      );
    });
  });
});
