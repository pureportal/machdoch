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
  ASSISTANT_POPUP_WINDOW_LABEL,
  ASSISTANT_SURFACE_READY_EVENT,
  MAIN_WINDOW_LABEL,
  QUICK_VOICE_START_EVENT,
  QUICK_VOICE_WINDOW_LABEL,
} from "./runtime";

import {
  computeAssistantSurfaceLayout,
  clampSurfacePosition,
  type AssistantSurfaceLayout,
} from "./assistant-surface-geometry";
export {
  ASSISTANT_BUBBLE_DIMENSIONS,
  ASSISTANT_POPUP_DIMENSIONS,
  QUICK_VOICE_DIMENSIONS,
} from "./assistant-surface-geometry";
export type { AssistantSurfaceLayout } from "./assistant-surface-geometry";
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

export const resolveMonitorTopologyKey = async (): Promise<string | null> => {
  if (!isTauri()) {
    return null;
  }

  try {
    const monitors = await availableMonitors();

    return monitors
      .map((monitor) => {
        const scaleFactor =
          typeof monitor.scaleFactor === "number" &&
          Number.isFinite(monitor.scaleFactor)
            ? monitor.scaleFactor.toFixed(3)
            : "1.000";

        return [
          monitor.position.x,
          monitor.position.y,
          monitor.size.width,
          monitor.size.height,
          monitor.workArea.position.x,
          monitor.workArea.position.y,
          monitor.workArea.size.width,
          monitor.workArea.size.height,
          scaleFactor,
        ].join(":");
      })
      .sort()
      .join("|");
  } catch {
    return null;
  }
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

const getOrCreateAssistantWindow = async (
  label: typeof ASSISTANT_POPUP_WINDOW_LABEL | typeof QUICK_VOICE_WINDOW_LABEL,
): Promise<Window | null> => {
  if (!isTauri()) {
    return getWindowByLabel(label);
  }

  const existingWindow = await getWindowByLabel(label);

  if (existingWindow) {
    return existingWindow;
  }

  const currentWindow = getCurrentWindow();
  let resolveReady: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const unlisten = await currentWindow.listen<{ label?: string }>(
    ASSISTANT_SURFACE_READY_EVENT,
    (event) => {
      if (event.payload.label === label) {
        resolveReady?.();
      }
    },
  );
  let readyTimeout: number | null = null;

  try {
    await invoke("ensure_assistant_window", { label });
    await Promise.race([
      readyPromise,
      new Promise<void>((resolve) => {
        readyTimeout = window.setTimeout(resolve, 3_000);
      }),
    ]);
  } catch (error) {
    console.error(`Failed to create assistant window \`${label}\``, error);
    return null;
  } finally {
    if (readyTimeout !== null) window.clearTimeout(readyTimeout);
    unlisten();
  }

  return getWindowByLabel(label);
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

const applyAssistantPopupLayout = async (
  popupWindow: Window | null,
  popupPositionOverride?: { x: number; y: number },
  resolvedLayout?: AssistantSurfaceLayout,
): Promise<void> => {
  if (!popupWindow) {
    return;
  }

  const layout = resolvedLayout ?? (await resolveAssistantSurfaceLayout());

  if (!layout) {
    return;
  }

  await setWindowPosition(
    popupWindow,
    clampSurfacePosition(
      popupPositionOverride ?? layout.popupPosition,
      layout.popupSize,
      layout.workArea,
    ),
  );
  await setWindowSize(popupWindow, layout.popupSize);
};

const closeWindowByLabel = async (
  label: string,
  description: string,
): Promise<void> => {
  const window = await getWindowByLabel(label);

  if (!window) {
    return;
  }

  try {
    await window.close();
  } catch (error) {
    console.error(`Failed to close ${description}`, error);
  }
};

export const hideAssistantPopup = async (): Promise<void> => {
  await closeWindowByLabel(ASSISTANT_POPUP_WINDOW_LABEL, "the assistant popup");
};

export const hideTransientAssistantWindows = async (): Promise<void> => {
  await Promise.all([
    hideAssistantPopup(),
    closeWindowByLabel(QUICK_VOICE_WINDOW_LABEL, "the Quick Voice window"),
  ]);
};

export const syncAssistantPopupPosition = async (
  layout?: AssistantSurfaceLayout,
): Promise<void> => {
  const popupWindow = await getWindowByLabel(ASSISTANT_POPUP_WINDOW_LABEL);

  if (!popupWindow) {
    return;
  }

  if (!(await popupWindow.isVisible())) {
    return;
  }

  await applyAssistantPopupLayout(popupWindow, undefined, layout);
};

export const isAssistantPopupVisible = async (): Promise<boolean> => {
  const popupWindow = await getWindowByLabel(ASSISTANT_POPUP_WINDOW_LABEL);

  if (!popupWindow) {
    return false;
  }

  try {
    return await popupWindow.isVisible();
  } catch (error) {
    console.error("Failed to inspect the assistant popup visibility", error);
    return false;
  }
};

export const showAssistantPopup = async (popupPositionOverride?: {
  x: number;
  y: number;
}): Promise<boolean> => {
  const popupWindow = await getOrCreateAssistantWindow(
    ASSISTANT_POPUP_WINDOW_LABEL,
  );

  if (!popupWindow) {
    return false;
  }

  try {
    await applyAssistantPopupLayout(popupWindow, popupPositionOverride);

    await Promise.all([popupWindow.show(), popupWindow.unminimize()]);
    await popupWindow.setFocus();
    return true;
  } catch (error) {
    console.error("Failed to show the assistant popup", error);
    return false;
  }
};

export const toggleAssistantPopup = async (popupPositionOverride?: {
  x: number;
  y: number;
}): Promise<boolean> => {
  const popupWindow = await getWindowByLabel(ASSISTANT_POPUP_WINDOW_LABEL);

  if (!popupWindow) {
    return showAssistantPopup(popupPositionOverride);
  }

  try {
    if (await popupWindow.isVisible()) {
      await popupWindow.close();
      return false;
    }

    return await showAssistantPopup(popupPositionOverride);
  } catch (error) {
    console.error("Failed to toggle the assistant popup", error);
    return false;
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
  const quickVoiceWindow = await getOrCreateAssistantWindow(
    QUICK_VOICE_WINDOW_LABEL,
  );

  if (!quickVoiceWindow) {
    return;
  }

  try {
    const layout = await resolveAssistantSurfaceLayout();

    if (layout) {
      await setWindowPosition(quickVoiceWindow, layout.quickVoicePosition);
      await setWindowSize(quickVoiceWindow, layout.quickVoiceSize);
    }

    await Promise.all([quickVoiceWindow.show(), quickVoiceWindow.unminimize()]);
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
