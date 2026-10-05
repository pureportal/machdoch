// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISPLAY_LAYOUT_CHANGED_EVENT } from "./assistant-surface";
import { useAssistantDisplayLayout } from "./use-assistant-display-layout";

const native = vi.hoisted(() => ({
  label: "quick-voice",
  listen: vi.fn(),
  onScaleChanged: vi.fn(),
  setPosition: vi.fn(),
  setSize: vi.fn(),
  current: vi.fn(),
  fromPoint: vi.fn(),
  cursor: vi.fn(),
  primary: vi.fn(),
  monitors: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/window")>()),
  getCurrentWindow: () => native,
  currentMonitor: native.current,
  monitorFromPoint: native.fromPoint,
  cursorPosition: native.cursor,
  primaryMonitor: native.primary,
  availableMonitors: native.monitors,
}));
vi.mock("./runtime", () => ({
  MAIN_WINDOW_LABEL: "main",
  QUICK_VOICE_START_EVENT: "start",
  QUICK_VOICE_WINDOW_LABEL: "quick-voice",
}));

const makeMonitor = (x: number, scaleFactor = 1): Monitor => ({
  name: "monitor",
  position: new PhysicalPosition(x, 0),
  size: new PhysicalSize(1920, 1080),
  scaleFactor,
  workArea: {
    position: new PhysicalPosition(x, 40),
    size: new PhysicalSize(1920, 1040),
  },
});
const unlisten = vi.fn();
const unscale = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  native.listen.mockResolvedValue(unlisten);
  native.onScaleChanged.mockResolvedValue(unscale);
  native.setPosition.mockResolvedValue(undefined);
  native.setSize.mockResolvedValue(undefined);
  native.current.mockResolvedValue(makeMonitor(-1920));
  native.cursor.mockResolvedValue({ x: 100, y: 100 });
  native.fromPoint.mockResolvedValue(null);
  native.primary.mockResolvedValue(null);
  native.monitors.mockResolvedValue([]);
});
afterEach(cleanup);

describe("Quick Voice display layout integration", () => {
  it("applies native geometry on display and DPI changes while keeping window affinity", async () => {
    const { unmount } = renderHook(() => useAssistantDisplayLayout());
    await waitFor(() =>
      expect(native.listen).toHaveBeenCalledWith(
        DISPLAY_LAYOUT_CHANGED_EVENT,
        expect.any(Function),
      ),
    );
    expect(native.setSize).not.toHaveBeenCalled();

    await act(async () => {
      (native.listen.mock.calls[0]![1] as () => void)();
    });
    await waitFor(() =>
      expect(native.setSize).toHaveBeenLastCalledWith(new PhysicalSize(380, 220)),
    );
    expect(native.setPosition).toHaveBeenLastCalledWith(
      new PhysicalPosition(-404, 836),
    );

    native.current.mockResolvedValue(makeMonitor(0, 1.5));
    await act(async () => {
      (native.onScaleChanged.mock.calls[0]![0] as () => void)();
    });
    await waitFor(() =>
      expect(native.setSize).toHaveBeenLastCalledWith(new PhysicalSize(570, 330)),
    );
    expect(native.setPosition).toHaveBeenLastCalledWith(
      new PhysicalPosition(1314, 714),
    );
    expect(native.cursor).not.toHaveBeenCalled();
    expect(native.setPosition.mock.invocationCallOrder[1]).toBeLessThan(
      native.setSize.mock.invocationCallOrder[1]!,
    );

    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(unscale).toHaveBeenCalledOnce();
  });

  it("applies the latest display after a slow native size update completes", async () => {
    let finishSize!: () => void;
    native.setSize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSize = resolve;
        }),
    );
    renderHook(() => useAssistantDisplayLayout());
    await act(async () => {});
    await act(async () => {
      (native.listen.mock.calls[0]![1] as () => void)();
    });
    await waitFor(() => expect(native.setSize).toHaveBeenCalledOnce());

    native.current.mockResolvedValue(makeMonitor(0, 1.5));
    await act(async () => {
      (native.onScaleChanged.mock.calls[0]![0] as () => void)();
    });
    expect(native.current).toHaveBeenCalledOnce();
    expect(native.setPosition).toHaveBeenCalledOnce();

    await act(async () => finishSize());
    await waitFor(() => expect(native.setSize).toHaveBeenCalledTimes(2));
    expect(native.current).toHaveBeenCalledTimes(2);
    expect(native.setPosition).toHaveBeenLastCalledWith(
      new PhysicalPosition(1314, 714),
    );
    expect(native.setSize).toHaveBeenLastCalledWith(new PhysicalSize(570, 330));
  });

  it("resumes native layout updates when a display reconnects", async () => {
    native.current.mockResolvedValue(null);
    renderHook(() => useAssistantDisplayLayout());
    await act(async () => {});
    await act(async () => {
      (native.listen.mock.calls[0]![1] as () => void)();
    });
    await waitFor(() => expect(native.monitors).toHaveBeenCalledOnce());
    expect(native.setPosition).not.toHaveBeenCalled();
    expect(native.setSize).not.toHaveBeenCalled();

    native.current.mockResolvedValue(makeMonitor(1920));
    await act(async () => {
      (native.listen.mock.calls[0]![1] as () => void)();
    });
    await waitFor(() =>
      expect(native.setSize).toHaveBeenCalledWith(new PhysicalSize(380, 220)),
    );
    expect(native.setPosition).toHaveBeenCalledWith(
      new PhysicalPosition(3436, 836),
    );
  });
});
