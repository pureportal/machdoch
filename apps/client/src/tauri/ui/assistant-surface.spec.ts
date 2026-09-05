import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import {
  resolveAssistantSurfaceLayout,
  resolveMonitorTopologyKey,
  showAssistantPopup,
  showQuickVoiceWindow,
} from "./assistant-surface";

const native = vi.hoisted(() => ({
  current: vi.fn(),
  primary: vi.fn(),
  fromPoint: vi.fn(),
  monitors: vi.fn(),
  cursor: vi.fn(),
  setPosition: vi.fn(),
  setSize: vi.fn(),
  show: vi.fn(),
  unminimize: vi.fn(),
  setFocus: vi.fn(),
  emitTo: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/window")>()),
  availableMonitors: native.monitors,
  currentMonitor: native.current,
  primaryMonitor: native.primary,
  monitorFromPoint: native.fromPoint,
  cursorPosition: native.cursor,
  Window: { getByLabel: async (label: string) => ({ ...native, label }) },
  getCurrentWindow: () => ({ ...native, label: "quick-voice" }),
}));
vi.mock("./runtime", () => ({
  ASSISTANT_POPUP_WINDOW_LABEL: "assistant-popup",
  ASSISTANT_SURFACE_READY_EVENT: "ready",
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
beforeEach(() => {
  vi.clearAllMocks();
  native.current.mockResolvedValue(makeMonitor(-1920));
  native.fromPoint.mockResolvedValue(makeMonitor(0, 1.5));
  native.cursor.mockResolvedValue({ x: 100, y: 100 });
  native.primary.mockResolvedValue(makeMonitor(0));
  native.monitors.mockResolvedValue([makeMonitor(-1920), makeMonitor(0)]);
});

describe("display selection and application", () => {
  it("keeps background surfaces on their display while explicit launches can use the cursor display", async () => {
    expect(
      (await resolveAssistantSurfaceLayout("window"))?.monitorBounds.x,
    ).toBe(-1920);
    expect(native.cursor).not.toHaveBeenCalled();
    expect((await resolveAssistantSurfaceLayout())?.monitorBounds.x).toBe(0);
  });
  it("recovers through transient missing and invalid displays without caching a disconnected monitor", async () => {
    native.current.mockResolvedValue(null);
    native.fromPoint.mockRejectedValue(new Error("disconnected"));
    native.primary.mockResolvedValue({
      ...makeMonitor(0),
      size: new PhysicalSize(0, 0),
    });
    native.monitors.mockResolvedValue([makeMonitor(-2560)]);
    expect(
      (await resolveAssistantSurfaceLayout("window"))?.monitorBounds.x,
    ).toBe(-2560);
    native.monitors.mockResolvedValue([]);
    expect(await resolveAssistantSurfaceLayout("window")).toBeNull();
    native.monitors.mockResolvedValue([makeMonitor(1920)]);
    expect(
      (await resolveAssistantSurfaceLayout("window"))?.monitorBounds.x,
    ).toBe(1920);
  });
  it("uses physical coordinates and sizes when launching on a different DPI display", async () => {
    await showQuickVoiceWindow();
    expect(native.setSize).toHaveBeenCalledWith(new PhysicalSize(570, 330));
    expect(native.setPosition.mock.invocationCallOrder[0]).toBeLessThan(
      native.setSize.mock.invocationCallOrder[0]!,
    );
    expect(native.show).toHaveBeenCalledOnce();
  });
  it("keeps explicit popup anchors inside the current work area", async () => {
    expect(await showAssistantPopup({ x: 9000, y: -9000 })).toBe(true);
    expect(native.setPosition).toHaveBeenCalledWith(
      new PhysicalPosition(1248, 40),
    );
  });
  it("ignores enumeration order but detects resolution, taskbar and scaling changes", async () => {
    const key = await resolveMonitorTopologyKey();
    native.monitors.mockResolvedValue([makeMonitor(0), makeMonitor(-1920)]);
    expect(await resolveMonitorTopologyKey()).toBe(key);
    native.monitors.mockResolvedValue([makeMonitor(0, 2), makeMonitor(-1920)]);
    expect(await resolveMonitorTopologyKey()).not.toBe(key);
    native.monitors.mockRejectedValue(new Error("transition"));
    expect(await resolveMonitorTopologyKey()).toBeNull();
  });
});
