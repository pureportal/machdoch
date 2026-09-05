// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAssistantDisplayLayout } from "./use-assistant-display-layout";

const native = vi.hoisted(() => ({
  listen: vi.fn(),
  scale: vi.fn(),
  resolve: vi.fn(),
  position: vi.fn(),
  size: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: native.listen,
    onScaleChanged: native.scale,
  }),
}));
vi.mock("./assistant-surface", () => ({
  DISPLAY_LAYOUT_CHANGED_EVENT: "display-change",
  resolveAssistantSurfaceLayout: native.resolve,
  setWindowPosition: native.position,
  setWindowSize: native.size,
}));
const layout = {
  popupPosition: { x: -500, y: 100 },
  popupSize: { width: 400, height: 600 },
  quickVoicePosition: { x: -400, y: 200 },
  quickVoiceSize: { width: 300, height: 200 },
};
const unlisten = vi.fn();
const unscale = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  native.listen.mockResolvedValue(unlisten);
  native.scale.mockResolvedValue(unscale);
  native.resolve.mockResolvedValue(layout);
  native.position.mockResolvedValue(true);
  native.size.mockResolvedValue(true);
});
afterEach(cleanup);

it("coalesces display-change storms, uses window affinity and cleans up subscriptions", async () => {
  const { unmount } = renderHook(() => useAssistantDisplayLayout("popup"));
  await act(async () => {});
  let finish!: (value: typeof layout) => void;
  native.resolve.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = native.listen.mock.calls[0]![1] as () => void;
  await act(async () => {
    refresh();
    refresh();
    refresh();
  });
  expect(native.resolve).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(layout);
  });
  expect(native.resolve).toHaveBeenCalledTimes(2);
  expect(native.resolve).toHaveBeenLastCalledWith("window");
  expect(native.position).toHaveBeenLastCalledWith(
    expect.anything(),
    layout.popupPosition,
  );
  expect(native.size).toHaveBeenLastCalledWith(
    expect.anything(),
    layout.popupSize,
  );
  unmount();
  expect(unlisten).toHaveBeenCalledOnce();
  expect(unscale).toHaveBeenCalledOnce();
});

it("does not mutate a destroyed window when monitor lookup completes after disposal", async () => {
  let finish!: (value: typeof layout) => void;
  native.resolve.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = renderHook(() => useAssistantDisplayLayout("quickVoice"));
  await act(async () => {});
  await act(async () => {
    (native.scale.mock.calls[0]![0] as () => void)();
  });
  unmount();
  await act(async () => {
    finish(layout);
  });
  expect(native.position).not.toHaveBeenCalled();
  expect(native.size).not.toHaveBeenCalled();
});

it("cleans up listeners that register after unmount", async () => {
  let finish!: (value: () => void) => void;
  native.listen.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = renderHook(() => useAssistantDisplayLayout("quickVoice"));
  unmount();
  await act(async () => {
    finish(unlisten);
  });
  expect(unlisten).toHaveBeenCalledOnce();
  expect(unscale).toHaveBeenCalledOnce();
});
