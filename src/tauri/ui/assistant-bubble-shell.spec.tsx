import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialShellState,
  createSession,
  type ShellPersistedState,
} from "./chat-session.model";
import { AssistantBubbleShell } from "./assistant-bubble-shell";
import {
  availableMonitors,
  currentWindowMock,
  isTauriMock,
  type MonitorMock,
  monitorFromPoint,
  PhysicalPosition,
  PhysicalSize,
  windowDragDropListeners,
  windowMovedListeners,
  windowResizedListeners,
  windowScaleChangedListeners,
} from "./test/tauri-test-mocks";
import type { AppearanceSettings } from "./lib/shell-store";
import {
  ASSISTANT_POPUP_WINDOW_LABEL,
  QUICK_CHAT_DROP_EVENT,
} from "./runtime";

const SHELL_STATE_STORAGE_KEY = "machdoch.desktop.shell-state";
const APPEARANCE_STORAGE_KEY = "machdoch.desktop.appearance-state";

const createMonitorMock = (
  overrides: Partial<MonitorMock> = {},
): MonitorMock => ({
  position: { x: 0, y: 0 },
  size: { width: 1920, height: 1080 },
  workArea: {
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1040 },
  },
  scaleFactor: 1,
  ...overrides,
});

const storeShellState = (value: ShellPersistedState): void => {
  window.localStorage.setItem(SHELL_STATE_STORAGE_KEY, JSON.stringify(value));
};

const storeAppearanceSettings = (
  partial: Partial<AppearanceSettings>,
): void => {
  window.localStorage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      theme: "dark",
      density: "comfortable",
      accent: "sky",
      quickChatBubbleStyle: "classic",
      ...partial,
    } satisfies AppearanceSettings),
  );
};

describe("AssistantBubbleShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(false);
    availableMonitors.mockResolvedValue([]);
    monitorFromPoint.mockResolvedValue(null);
    currentWindowMock.innerSize.mockResolvedValue(new PhysicalSize(0, 0));
    currentWindowMock.outerPosition.mockResolvedValue(new PhysicalPosition(0, 0));
    windowDragDropListeners.clear();
    windowMovedListeners.clear();
    windowResizedListeners.clear();
    windowScaleChangedListeners.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    windowDragDropListeners.clear();
    windowMovedListeners.clear();
    windowResizedListeners.clear();
    windowScaleChangedListeners.clear();
    window.localStorage.clear();
  });

  it("exposes idle launcher state and popup accessibility metadata", async () => {
    render(<AssistantBubbleShell />);

    const bubble = await screen.findByRole("button", {
      name: "Open Quick Chat",
    });

    await waitFor(() => {
      expect(bubble.getAttribute("data-state")).toBe("idle");
    });

    expect(bubble.getAttribute("aria-haspopup")).toBe("dialog");
    expect(bubble.getAttribute("aria-expanded")).toBe("false");
    expect(bubble.getAttribute("data-running")).toBe("false");
    expect(bubble.getAttribute("data-has-notification")).toBe("false");
    expect(bubble.getAttribute("data-voice-enabled")).toBe("true");
  });

  it("forwards dropped files from the launcher bubble to Quick Chat", async () => {
    isTauriMock.mockReturnValue(true);

    render(<AssistantBubbleShell />);

    const bubble = await screen.findByRole("button", {
      name: "Open Quick Chat",
    });

    await waitFor(() => {
      expect(windowDragDropListeners.size).toBe(1);
    });

    const [listener] = windowDragDropListeners;

    await act(async () => {
      listener?.({
        payload: {
          type: "drop",
          paths: ["C:\\Docs\\quick-note.txt"],
          position: { x: 12, y: 18 },
        },
      });
    });

    await waitFor(() => {
      expect(currentWindowMock.emitTo).toHaveBeenCalledWith(
        ASSISTANT_POPUP_WINDOW_LABEL,
        QUICK_CHAT_DROP_EVENT,
        { paths: ["C:\\Docs\\quick-note.txt"] },
      );
      expect(bubble.getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("marks running sessions for stateful attention styles", async () => {
    const runningSession = createSession({
      id: "session-running",
      messages: [
        {
          id: "task-running",
          role: "user",
          content: "Run the task",
          createdAt: 1,
        },
      ],
      updatedAt: 1,
    });

    storeShellState({
      ...createInitialShellState(),
      activeSessionId: runningSession.id,
      sessions: [runningSession],
    });
    storeAppearanceSettings({ quickChatBubbleStyle: "pulse" });

    render(<AssistantBubbleShell />);

    const bubble = await screen.findByRole("button", {
      name: "Open Quick Chat",
    });

    await waitFor(() => {
      expect(bubble.getAttribute("data-style")).toBe("pulse");
      expect(bubble.getAttribute("data-state")).toBe("running");
      expect(bubble.getAttribute("data-running")).toBe("true");
      expect(bubble.getAttribute("data-has-notification")).toBe("true");
    });

    expect(screen.getByText("1")).toBeDefined();
  });

  it("syncs the transparent bubble window size for shadow padding", async () => {
    isTauriMock.mockReturnValue(true);
    const monitor = createMonitorMock();

    availableMonitors.mockResolvedValue([monitor]);
    monitorFromPoint.mockResolvedValue(monitor);

    render(<AssistantBubbleShell />);

    await waitFor(() => {
      expect(currentWindowMock.setSize).toHaveBeenCalledWith(
        expect.objectContaining({ width: 128, height: 104 }),
      );
    });
  });

  it("reapplies the bubble position when the OS moves it during display changes", async () => {
    isTauriMock.mockReturnValue(true);
    const monitor = createMonitorMock();

    availableMonitors.mockResolvedValue([monitor]);
    monitorFromPoint.mockResolvedValue(monitor);
    currentWindowMock.innerSize.mockResolvedValue(new PhysicalSize(128, 104));
    currentWindowMock.outerPosition.mockResolvedValue(new PhysicalPosition(1768, 912));

    render(<AssistantBubbleShell />);

    await waitFor(() => {
      expect(windowMovedListeners.size).toBe(1);
    });
    await waitFor(() => {
      expect(currentWindowMock.setPosition).toHaveBeenCalledWith(
        expect.objectContaining({ x: 1768, y: 912 }),
      );
    });

    currentWindowMock.setPosition.mockClear();
    currentWindowMock.outerPosition.mockResolvedValue(new PhysicalPosition(140, 96));

    await act(async () => {
      for (const listener of windowMovedListeners) {
        listener({ payload: new PhysicalPosition(140, 96) });
      }

      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });

    await waitFor(() => {
      expect(currentWindowMock.setPosition).toHaveBeenCalledWith(
        expect.objectContaining({ x: 1768, y: 912 }),
      );
    });
  });

  it("resyncs physical bubble geometry on scale changes", async () => {
    isTauriMock.mockReturnValue(true);
    let monitor = createMonitorMock();

    availableMonitors.mockImplementation(async () => [monitor]);
    monitorFromPoint.mockImplementation(async () => monitor);
    currentWindowMock.innerSize.mockResolvedValue(new PhysicalSize(128, 104));
    currentWindowMock.outerPosition.mockResolvedValue(new PhysicalPosition(1768, 912));

    render(<AssistantBubbleShell />);

    await waitFor(() => {
      expect(windowScaleChangedListeners.size).toBe(1);
    });
    await waitFor(() => {
      expect(currentWindowMock.setSize).toHaveBeenCalledWith(
        expect.objectContaining({ width: 128, height: 104 }),
      );
    });

    currentWindowMock.setPosition.mockClear();
    currentWindowMock.setSize.mockClear();
    monitor = createMonitorMock({ scaleFactor: 1.25 });

    await act(async () => {
      for (const listener of windowScaleChangedListeners) {
        listener({
          payload: {
            scaleFactor: 1.25,
            size: new PhysicalSize(160, 130),
          },
        });
      }

      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });

    await waitFor(() => {
      expect(currentWindowMock.setSize).toHaveBeenCalledWith(
        expect.objectContaining({ width: 160, height: 130 }),
      );
      expect(currentWindowMock.setPosition).toHaveBeenCalledWith(
        expect.objectContaining({ x: 1730, y: 880 }),
      );
    });
  });
});
