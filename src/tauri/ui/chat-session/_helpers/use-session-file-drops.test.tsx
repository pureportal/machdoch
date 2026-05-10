import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowDragDropListeners } from "../../test/tauri-test-mocks";
import { useSessionFileDrops } from "./use-session-file-drops";

describe("useSessionFileDrops", () => {
  beforeEach(() => {
    windowDragDropListeners.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
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
});
