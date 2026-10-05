import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import {
  hideTransientAssistantWindows,
  resolveAssistantSurfaceLayout,
  showQuickVoiceWindow,
} from "./assistant-surface";

const native = vi.hoisted(() => ({
  tauri: true,
  windowExists: true,
  current: vi.fn(),
  primary: vi.fn(),
  fromPoint: vi.fn(),
  monitors: vi.fn(),
  cursor: vi.fn(),
  setPosition: vi.fn(),
  setSize: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  unminimize: vi.fn(),
  setFocus: vi.fn(),
  emitTo: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.tauri,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/window")>()),
  availableMonitors: native.monitors,
  currentMonitor: native.current,
  primaryMonitor: native.primary,
  monitorFromPoint: native.fromPoint,
  cursorPosition: native.cursor,
  Window: {
    getByLabel: async (label: string) =>
      native.windowExists ? { ...native, label } : null,
  },
  getCurrentWindow: () => ({ ...native, label: "main" }),
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

beforeEach(() => {
  vi.resetAllMocks();
  native.tauri = true;
  native.windowExists = true;
  vi.mocked(invoke).mockImplementation(async () => {
    native.windowExists = true;
  });
  native.current.mockResolvedValue(makeMonitor(-1920));
  native.fromPoint.mockResolvedValue(makeMonitor(0, 1.5));
  native.cursor.mockResolvedValue({ x: 100, y: 100 });
  native.primary.mockResolvedValue(makeMonitor(0));
  native.monitors.mockResolvedValue([makeMonitor(-1920), makeMonitor(0)]);
  for (const mutate of [
    native.setPosition,
    native.setSize,
    native.show,
    native.close,
    native.unminimize,
    native.setFocus,
    native.emitTo,
  ]) {
    mutate.mockResolvedValue(undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("display selection and application", () => {
  it("creates Quick Voice, reveals it and starts recording from the source window", async () => {
    native.windowExists = false;

    await showQuickVoiceWindow();

    expect(invoke).toHaveBeenCalledWith("ensure_assistant_window", {
      label: "quick-voice",
    });
    expect(native.show).toHaveBeenCalledOnce();
    expect(native.setFocus).toHaveBeenCalledOnce();
    expect(native.emitTo).toHaveBeenCalledWith("quick-voice", "start", {
      sourceWindowLabel: "main",
    });
    expect(vi.mocked(invoke).mock.invocationCallOrder[0]).toBeLessThan(
      native.setPosition.mock.invocationCallOrder[0]!,
    );
    expect(native.show.mock.invocationCallOrder[0]).toBeLessThan(
      native.setFocus.mock.invocationCallOrder[0]!,
    );
    expect(native.setFocus.mock.invocationCallOrder[0]).toBeLessThan(
      native.emitTo.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps display updates on the window display while launches use the cursor display", async () => {
    expect(await resolveAssistantSurfaceLayout("window")).toEqual({
      quickVoicePosition: { x: -404, y: 836 },
      quickVoiceSize: { width: 380, height: 220 },
    });
    expect(native.cursor).not.toHaveBeenCalled();
    expect(await resolveAssistantSurfaceLayout()).toEqual({
      quickVoicePosition: { x: 1314, y: 714 },
      quickVoiceSize: { width: 570, height: 330 },
    });
    expect(native.fromPoint).toHaveBeenCalledWith(100, 100);
  });

  it("recovers through missing and invalid displays without caching a disconnected monitor", async () => {
    native.current.mockResolvedValue(null);
    native.fromPoint.mockRejectedValue(new Error("disconnected"));
    native.primary.mockResolvedValue({
      ...makeMonitor(0),
      size: new PhysicalSize(0, 0),
    });
    native.monitors.mockResolvedValue([
      { ...makeMonitor(0), size: new PhysicalSize(0, 0) },
      makeMonitor(-2560),
    ]);

    expect(await resolveAssistantSurfaceLayout("window")).toEqual({
      quickVoicePosition: { x: -1044, y: 836 },
      quickVoiceSize: { width: 380, height: 220 },
    });
    native.monitors.mockResolvedValue([]);
    expect(await resolveAssistantSurfaceLayout("window")).toBeNull();
    native.monitors.mockResolvedValue([makeMonitor(1920)]);
    expect(await resolveAssistantSurfaceLayout("window")).toEqual({
      quickVoicePosition: { x: 3436, y: 836 },
      quickVoiceSize: { width: 380, height: 220 },
    });
  });

  it("applies physical coordinates and sizes before revealing Quick Voice on a different DPI display", async () => {
    await showQuickVoiceWindow();

    expect(invoke).not.toHaveBeenCalled();
    expect(native.setPosition).toHaveBeenCalledWith(
      new PhysicalPosition(1314, 714),
    );
    expect(native.setSize).toHaveBeenCalledWith(new PhysicalSize(570, 330));
    expect(native.setPosition.mock.invocationCallOrder[0]).toBeLessThan(
      native.setSize.mock.invocationCallOrder[0]!,
    );
    expect(native.setSize.mock.invocationCallOrder[0]).toBeLessThan(
      native.unminimize.mock.invocationCallOrder[0]!,
    );
    expect(native.unminimize.mock.invocationCallOrder[0]).toBeLessThan(
      native.show.mock.invocationCallOrder[0]!,
    );
  });

  it("starts Quick Voice when display information is temporarily unavailable", async () => {
    native.current.mockResolvedValue(null);
    native.fromPoint.mockResolvedValue(null);
    native.primary.mockResolvedValue(null);
    native.monitors.mockResolvedValue([]);

    await showQuickVoiceWindow();

    expect(native.setPosition).not.toHaveBeenCalled();
    expect(native.setSize).not.toHaveBeenCalled();
    expect(native.show).toHaveBeenCalledOnce();
    expect(native.emitTo).toHaveBeenCalledWith("quick-voice", "start", {
      sourceWindowLabel: "main",
    });
  });

  it("reports failed Quick Voice creation without emitting a recording request", async () => {
    const error = new Error("window creation failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    native.windowExists = false;
    vi.mocked(invoke).mockRejectedValueOnce(error);

    await showQuickVoiceWindow();

    expect(log).toHaveBeenCalledWith(
      "Failed to create the Quick Voice window",
      error,
    );
    expect(native.show).not.toHaveBeenCalled();
    expect(native.emitTo).not.toHaveBeenCalled();
  });

  it("closes the transient Quick Voice window", async () => {
    await hideTransientAssistantWindows();

    expect(native.close).toHaveBeenCalledOnce();
    expect(native.show).not.toHaveBeenCalled();
    native.windowExists = false;
    await hideTransientAssistantWindows();
    expect(native.close).toHaveBeenCalledOnce();
  });

  it("skips native monitor lookup and Quick Voice launch in the browser", async () => {
    native.tauri = false;

    expect(await resolveAssistantSurfaceLayout()).toBeNull();
    await showQuickVoiceWindow();

    expect(native.current).not.toHaveBeenCalled();
    expect(native.cursor).not.toHaveBeenCalled();
    expect(native.monitors).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(native.show).not.toHaveBeenCalled();
    expect(native.emitTo).not.toHaveBeenCalled();
  });
});
