// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantBubbleShell } from "./assistant-bubble-shell";

const native = vi.hoisted(() => ({
  visible: false,
  size: { width: 900, height: 700 },
  position: { x: 0, y: 0 },
  innerSize: vi.fn(),
  outerPosition: vi.fn(),
  isVisible: vi.fn(),
  isMaximized: vi.fn(),
  unmaximize: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  listen: vi.fn(),
  onScaleChanged: vi.fn(),
  onMoved: vi.fn(),
  onResized: vi.fn(),
  setWindowSize: vi.fn(),
  setWindowPosition: vi.fn(),
  resolveLayout: vi.fn(),
  resolveTopology: vi.fn(),
  detectFullscreen: vi.fn(),
  loadTasks: vi.fn(),
  subscribeTasks: vi.fn(),
  togglePopup: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
vi.mock("./assistant-surface", () => ({
  DISPLAY_LAYOUT_CHANGED_EVENT: "display-change",
  resolveAssistantSurfaceLayout: native.resolveLayout,
  resolveMonitorTopologyKey: native.resolveTopology,
  setWindowSize: native.setWindowSize,
  setWindowPosition: native.setWindowPosition,
  syncAssistantPopupPosition: vi.fn().mockResolvedValue(undefined),
  toggleAssistantPopup: native.togglePopup,
  isAssistantPopupVisible: vi.fn().mockResolvedValue(false),
}));
vi.mock("./runtime", () => ({
  ASSISTANT_POPUP_WINDOW_LABEL: "assistant-popup",
  QUICK_CHAT_DROP_EVENT: "quick-chat-drop",
  detectFullscreenWindowOnMonitor: native.detectFullscreen,
  loadActiveDesktopTaskIds: native.loadTasks,
  subscribeToDesktopTaskProgress: native.subscribeTasks,
}));
vi.mock("./_helpers/use-user-desktop-settings", () => ({
  useUserDesktopSettings: () => ({
    assistantBubbleEnabled: true,
    assistantBubbleHideWhenFullscreen: true,
    assistantBubbleTemporarilyHideSeconds: 6,
    quickVoiceEnabled: false,
  }),
}));
vi.mock("./chat-session/_helpers/use-appearance-settings", () => ({
  useAppearanceSettings: () => ({
    settings: { quickChatBubbleStyle: "default" },
  }),
}));
vi.mock("./chat-session/_helpers/use-session-file-drops", () => ({
  useSessionFileDrops: () => ({ isActive: false }),
}));
vi.mock("@machdoch/media-studio/tauri/ui/components/ui/tooltip.js", () => ({
  ControlTooltip: ({ children }: { children: ReactNode }) => children,
}));

const layout = {
  monitorBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  bubbleSize: { width: 128, height: 104 },
  bubblePosition: { x: 1768, y: 936 },
};

beforeEach(() => {
  vi.clearAllMocks();
  native.visible = false;
  native.size = { width: 900, height: 700 };
  native.position = { x: 0, y: 0 };
  native.innerSize.mockImplementation(async () => native.size);
  native.outerPosition.mockImplementation(async () => native.position);
  native.isVisible.mockImplementation(async () => native.visible);
  native.isMaximized.mockResolvedValue(false);
  native.show.mockImplementation(async () => {
    native.visible = true;
  });
  native.hide.mockImplementation(async () => {
    native.visible = false;
  });
  for (const subscribe of [
    native.listen,
    native.onScaleChanged,
    native.onMoved,
    native.onResized,
  ]) {
    subscribe.mockResolvedValue(() => undefined);
  }
  native.resolveLayout.mockResolvedValue(layout);
  native.resolveTopology.mockResolvedValue("monitor");
  native.detectFullscreen.mockResolvedValue(false);
  native.loadTasks.mockResolvedValue([]);
  native.subscribeTasks.mockResolvedValue(() => undefined);
  native.togglePopup.mockResolvedValue(true);
  native.setWindowSize.mockImplementation(async (_window, size) => {
    native.size = size;
    return true;
  });
  native.setWindowPosition.mockImplementation(async (_window, position) => {
    native.position = position;
    return true;
  });
});

afterEach(cleanup);

it("opens the popup when the bubble is clicked", async () => {
  render(createElement(AssistantBubbleShell));

  fireEvent.click(screen.getByRole("button", { name: "Open Quick Chat" }));

  await waitFor(() => expect(native.togglePopup).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Open Quick Chat" })
        .getAttribute("aria-expanded"),
    ).toBe("true"),
  );
});

it("keeps the bubble hidden while a slow size update is pending", async () => {
  let finishSize!: () => void;
  native.setWindowSize.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finishSize = () => {
          native.size = layout.bubbleSize;
          resolve(true);
        };
      }),
  );

  render(createElement(AssistantBubbleShell));
  await waitFor(() => expect(native.setWindowSize).toHaveBeenCalledOnce());
  expect(native.show).not.toHaveBeenCalled();

  await act(async () => finishSize());
  await waitFor(() => expect(native.show).toHaveBeenCalledOnce());
  expect(native.size).toEqual(layout.bubbleSize);
  expect(native.position).toEqual(layout.bubblePosition);
});

it("does not reveal the bubble after a failed size update and retries on resize", async () => {
  native.setWindowSize.mockResolvedValueOnce(false);

  render(createElement(AssistantBubbleShell));
  await waitFor(() => expect(native.setWindowSize).toHaveBeenCalledOnce());
  expect(native.show).not.toHaveBeenCalled();

  await waitFor(() => expect(native.onResized).toHaveBeenCalledOnce());
  await act(async () => {
    (native.onResized.mock.calls[0]![0] as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  await waitFor(() => expect(native.show).toHaveBeenCalledOnce());
  expect(native.setWindowSize).toHaveBeenCalledTimes(2);
});

it("does not reveal a window whose size remains large after an update", async () => {
  native.setWindowSize.mockResolvedValueOnce(true);

  render(createElement(AssistantBubbleShell));
  await waitFor(() => expect(native.setWindowSize).toHaveBeenCalledOnce());
  expect(native.show).not.toHaveBeenCalled();
  expect(native.size).toEqual({ width: 900, height: 700 });
});
