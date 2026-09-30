import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  availableMonitors,
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  monitorFromPoint,
  PhysicalPosition,
  PhysicalSize,
  primaryMonitor,
  Window,
} from "@tauri-apps/api/window";
import {
  MAIN_WINDOW_LABEL,
  QUICK_VOICE_START_EVENT,
  QUICK_VOICE_WINDOW_LABEL,
} from "./runtime";

import {
  computeAssistantSurfaceLayout,
  type AssistantSurfaceLayout,
} from "./assistant-surface-geometry";
export const DISPLAY_LAYOUT_CHANGED_EVENT = "machdoch://display-layout-changed";
type MonitorSnapshot = Awaited<ReturnType<typeof monitorFromPoint>>;

const resolveFirstAvailableMonitor = async (): Promise<MonitorSnapshot> => {
  try {
    const monitors = await availableMonitors();

    return (
      monitors.find((monitor) => computeAssistantSurfaceLayout(monitor)) ?? null
    );
  } catch {
    return null;
  }
};

const resolveTargetMonitor = async (
  target: "cursor" | "window",
): Promise<MonitorSnapshot> => {
  if (!isTauri()) {
    return null;
  }

  if (target === "window") {
    const monitor = await currentMonitor().catch(() => null);
    if (monitor && computeAssistantSurfaceLayout(monitor)) return monitor;
  }

  try {
    const cursor = await cursorPosition();
    const cursorMonitor = await monitorFromPoint(cursor.x, cursor.y);

    if (cursorMonitor && computeAssistantSurfaceLayout(cursorMonitor)) {
      return cursorMonitor;
    }
  } catch {
    // Cursor/monitor information can be temporarily unavailable while displays change.
  }

  for (const resolve of [
    currentMonitor,
    primaryMonitor,
    resolveFirstAvailableMonitor,
  ]) {
    const monitor = await resolve().catch(() => null);
    if (monitor && computeAssistantSurfaceLayout(monitor)) return monitor;
  }
  return null;
};

export const resolveAssistantSurfaceLayout = async (
  target: "cursor" | "window" = "cursor",
): Promise<AssistantSurfaceLayout | null> => {
  const monitor = await resolveTargetMonitor(target);
  return monitor ? computeAssistantSurfaceLayout(monitor) : null;
};

export const getWindowByLabel = async (
  label: string,
): Promise<Window | null> => {
  if (!isTauri()) {
    return null;
  }

  try {
    return await Window.getByLabel(label);
  } catch (error) {
    console.error(`Failed to get window \`${label}\``, error);
    return null;
  }
};

export const setWindowPosition = async (
  window: Window | null,
  position: { x: number; y: number },
): Promise<boolean> => {
  if (!window) {
    return false;
  }

  try {
    await window.setPosition(new PhysicalPosition(position.x, position.y));
    return true;
  } catch (error) {
    console.error(`Failed to position window \`${window.label}\``, error);
    return false;
  }
};

const getOrCreateQuickVoiceWindow = async (): Promise<Window | null> => {
  if (!isTauri()) {
    return getWindowByLabel(QUICK_VOICE_WINDOW_LABEL);
  }

  const existingWindow = await getWindowByLabel(QUICK_VOICE_WINDOW_LABEL);

  if (existingWindow) {
    return existingWindow;
  }

  try {
    await invoke("ensure_assistant_window", {
      label: QUICK_VOICE_WINDOW_LABEL,
    });
  } catch (error) {
    console.error("Failed to create the Quick Voice window", error);
    return null;
  }

  return getWindowByLabel(QUICK_VOICE_WINDOW_LABEL);
};

export const setWindowSize = async (
  window: Window | null,
  size: { width: number; height: number },
): Promise<boolean> => {
  if (!window) {
    return false;
  }

  try {
    await window.setSize(new PhysicalSize(size.width, size.height));
    return true;
  } catch (error) {
    console.error(`Failed to size window \`${window.label}\``, error);
    return false;
  }
};

export const hideTransientAssistantWindows = async (): Promise<void> => {
  const window = await getWindowByLabel(QUICK_VOICE_WINDOW_LABEL);
  if (!window) return;
  try {
    await window.close();
  } catch (error) {
    console.error("Failed to close the Quick Voice window", error);
  }
};

export const revealMainWindow = async (): Promise<void> => {
  if (isTauri()) {
    try {
      await invoke("reveal_main_window");
    } catch (error) {
      console.error("Failed to reveal the main window", error);
    }

    return;
  }

  const mainWindow = await getWindowByLabel(MAIN_WINDOW_LABEL);

  if (!mainWindow) {
    return;
  }

  try {
    await mainWindow.show();
    await mainWindow.unminimize();
    await mainWindow.setFocus();
  } catch (error) {
    console.error("Failed to reveal the main window", error);
  }
};

export const isMainWindowOpen = async (): Promise<boolean> => {
  if (!isTauri()) {
    return true;
  }

  const mainWindow = await getWindowByLabel(MAIN_WINDOW_LABEL);

  if (!mainWindow) {
    return false;
  }

  try {
    const [visible, minimized] = await Promise.all([
      mainWindow.isVisible(),
      mainWindow.isMinimized(),
    ]);

    return visible || minimized;
  } catch (error) {
    console.error("Failed to inspect the main window visibility", error);
    return false;
  }
};

export const hideMainWindowToTray = async (): Promise<void> => {
  if (!isTauri()) {
    return;
  }

  try {
    await invoke("hide_main_window_to_tray");
  } catch (error) {
    console.error("Failed to hide machdoch to the tray", error);
  }
};

export const quitMachdoch = async (): Promise<void> => {
  if (!isTauri()) {
    return;
  }

  try {
    await invoke("quit_machdoch");
  } catch (error) {
    console.error("Failed to quit machdoch", error);
  }
};

export const showQuickVoiceWindow = async (): Promise<void> => {
  const quickVoiceWindow = await getOrCreateQuickVoiceWindow();

  if (!quickVoiceWindow) {
    return;
  }

  try {
    const layout = await resolveAssistantSurfaceLayout();

    if (layout) {
      await setWindowPosition(quickVoiceWindow, layout.quickVoicePosition);
      await setWindowSize(quickVoiceWindow, layout.quickVoiceSize);
    }

    await quickVoiceWindow.unminimize();
    await quickVoiceWindow.show();
    await quickVoiceWindow.setFocus();
    await getCurrentWindow().emitTo(
      QUICK_VOICE_WINDOW_LABEL,
      QUICK_VOICE_START_EVENT,
      {
        sourceWindowLabel: getCurrentWindow().label,
      },
    );
  } catch (error) {
    console.error("Failed to show the quick voice window", error);
  }
};
