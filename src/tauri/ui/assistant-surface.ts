import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  monitorFromPoint,
  PhysicalPosition,
  PhysicalSize,
  Window,
} from "@tauri-apps/api/window";
import {
  ASSISTANT_POPUP_WINDOW_LABEL,
  MAIN_WINDOW_LABEL,
  QUICK_VOICE_START_EVENT,
  QUICK_VOICE_WINDOW_LABEL,
  type MonitorBoundsInput,
} from "./runtime";

export const ASSISTANT_BUBBLE_DIMENSIONS = {
  width: 112,
  height: 84,
} as const;

export const ASSISTANT_POPUP_DIMENSIONS = {
  width: 448,
  height: 720,
  minHeight: 420,
} as const;

export const QUICK_VOICE_DIMENSIONS = {
  width: 380,
  height: 220,
} as const;

const SURFACE_MARGIN = 24;
const POPUP_VERTICAL_GAP = 16;

type MonitorSnapshot = Awaited<ReturnType<typeof monitorFromPoint>>;

export interface AssistantSurfaceLayout {
  monitorBounds: MonitorBoundsInput;
  bubblePosition: { x: number; y: number };
  popupSize: { width: number; height: number };
  popupPosition: { x: number; y: number };
  quickVoicePosition: { x: number; y: number };
}

const clampPosition = (value: number, min: number, max: number): number => {
  if (min > max) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
};

const toPhysicalPixels = (logicalValue: number, scaleFactor: number): number => {
  return Math.round(logicalValue * scaleFactor);
};

const toMonitorBounds = (monitor: NonNullable<MonitorSnapshot>): MonitorBoundsInput => {
  return {
    x: monitor.position.x,
    y: monitor.position.y,
    width: monitor.size.width,
    height: monitor.size.height,
  };
};

const resolveTargetMonitor = async (): Promise<MonitorSnapshot> => {
  if (!isTauri()) {
    return null;
  }

  const cursor = await cursorPosition();
  return (await monitorFromPoint(cursor.x, cursor.y)) ?? (await currentMonitor());
};

export const resolveAssistantSurfaceLayout = async (): Promise<AssistantSurfaceLayout | null> => {
  const monitor = await resolveTargetMonitor();

  if (!monitor) {
    return null;
  }

  const workX = monitor.workArea.position.x;
  const workY = monitor.workArea.position.y;
  const workWidth = monitor.workArea.size.width;
  const workHeight = monitor.workArea.size.height;
  const scaleFactor =
    typeof monitor.scaleFactor === "number" && Number.isFinite(monitor.scaleFactor)
      ? monitor.scaleFactor
      : 1;
  const surfaceMargin = toPhysicalPixels(SURFACE_MARGIN, scaleFactor);
  const popupVerticalGap = toPhysicalPixels(POPUP_VERTICAL_GAP, scaleFactor);
  const bubbleWidth = toPhysicalPixels(
    ASSISTANT_BUBBLE_DIMENSIONS.width,
    scaleFactor,
  );
  const bubbleHeight = toPhysicalPixels(
    ASSISTANT_BUBBLE_DIMENSIONS.height,
    scaleFactor,
  );
  const popupWidth = toPhysicalPixels(
    ASSISTANT_POPUP_DIMENSIONS.width,
    scaleFactor,
  );
  const preferredPopupHeight = toPhysicalPixels(
    ASSISTANT_POPUP_DIMENSIONS.height,
    scaleFactor,
  );
  const minimumPopupHeight = toPhysicalPixels(
    ASSISTANT_POPUP_DIMENSIONS.minHeight,
    scaleFactor,
  );
  const quickVoiceWidth = toPhysicalPixels(
    QUICK_VOICE_DIMENSIONS.width,
    scaleFactor,
  );
  const quickVoiceHeight = toPhysicalPixels(
    QUICK_VOICE_DIMENSIONS.height,
    scaleFactor,
  );
  const bubbleX =
    clampPosition(
      workX + workWidth - bubbleWidth - surfaceMargin,
      workX + surfaceMargin,
      workX + workWidth - bubbleWidth - surfaceMargin,
    );
  const bubbleY = clampPosition(
    workY + workHeight - bubbleHeight - surfaceMargin,
    workY + surfaceMargin,
    workY + workHeight - bubbleHeight - surfaceMargin,
  );
  const popupHeightAvailableAboveBubble =
    bubbleY - workY - surfaceMargin - popupVerticalGap;
  const popupHeight = clampPosition(
    preferredPopupHeight,
    minimumPopupHeight,
    popupHeightAvailableAboveBubble,
  );
  const popupX = clampPosition(
    workX + workWidth - popupWidth - surfaceMargin,
    workX + surfaceMargin,
    workX + workWidth - popupWidth - surfaceMargin,
  );
  const popupY = clampPosition(
    bubbleY - popupHeight - popupVerticalGap,
    workY + surfaceMargin,
    workY + workHeight - popupHeight - surfaceMargin,
  );
  const quickVoiceX =
    clampPosition(
      workX + workWidth - quickVoiceWidth - surfaceMargin,
      workX + surfaceMargin,
      workX + workWidth - quickVoiceWidth - surfaceMargin,
    );
  const quickVoiceY = clampPosition(
    workY + workHeight - quickVoiceHeight - surfaceMargin,
    workY + surfaceMargin,
    workY + workHeight - quickVoiceHeight - surfaceMargin,
  );

  return {
    monitorBounds: toMonitorBounds(monitor),
    bubblePosition: { x: bubbleX, y: bubbleY },
    popupSize: { width: popupWidth, height: popupHeight },
    popupPosition: { x: popupX, y: popupY },
    quickVoicePosition: { x: quickVoiceX, y: quickVoiceY },
  };
};

export const getWindowByLabel = async (label: string): Promise<Window | null> => {
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
): Promise<void> => {
  if (!window) {
    return;
  }

  try {
    await window.setPosition(new PhysicalPosition(position.x, position.y));
  } catch (error) {
    console.error(`Failed to position window \`${window.label}\``, error);
  }
};

export const setWindowSize = async (
  window: Window | null,
  size: { width: number; height: number },
): Promise<void> => {
  if (!window) {
    return;
  }

  try {
    await window.setSize(new PhysicalSize(size.width, size.height));
  } catch (error) {
    console.error(`Failed to size window \`${window.label}\``, error);
  }
};

const applyAssistantPopupLayout = async (
  popupWindow: Window | null,
  popupPositionOverride?: { x: number; y: number },
): Promise<void> => {
  if (!popupWindow) {
    return;
  }

  const layout = await resolveAssistantSurfaceLayout();

  if (!layout) {
    if (popupPositionOverride) {
      await setWindowPosition(popupWindow, popupPositionOverride);
    }

    return;
  }

  await setWindowSize(popupWindow, layout.popupSize);
  await setWindowPosition(
    popupWindow,
    popupPositionOverride ?? layout.popupPosition,
  );
};

const hideWindowByLabel = async (
  label: string,
  description: string,
): Promise<void> => {
  const window = await getWindowByLabel(label);

  if (!window) {
    return;
  }

  try {
    await window.hide();
  } catch (error) {
    console.error(`Failed to hide ${description}`, error);
  }
};

export const hideAssistantPopup = async (): Promise<void> => {
  await hideWindowByLabel(
    ASSISTANT_POPUP_WINDOW_LABEL,
    "the assistant popup",
  );
};

export const hideTransientAssistantWindows = async (): Promise<void> => {
  await Promise.all([
    hideAssistantPopup(),
    hideWindowByLabel(QUICK_VOICE_WINDOW_LABEL, "the Quick Voice window"),
  ]);
};

export const syncAssistantPopupPosition = async (): Promise<void> => {
  const popupWindow = await getWindowByLabel(ASSISTANT_POPUP_WINDOW_LABEL);

  if (!popupWindow) {
    return;
  }

  if (!(await popupWindow.isVisible())) {
    return;
  }

  await applyAssistantPopupLayout(popupWindow);
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

export const toggleAssistantPopup = async (
  popupPositionOverride?: { x: number; y: number },
): Promise<boolean> => {
  const popupWindow = await getWindowByLabel(ASSISTANT_POPUP_WINDOW_LABEL);

  if (!popupWindow) {
    return false;
  }

  try {
    if (await popupWindow.isVisible()) {
      await popupWindow.hide();
      return false;
    }

    await applyAssistantPopupLayout(popupWindow, popupPositionOverride);

    await Promise.all([popupWindow.show(), popupWindow.unminimize()]);
    await popupWindow.setFocus();
    return true;
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
  const quickVoiceWindow = await getWindowByLabel(QUICK_VOICE_WINDOW_LABEL);

  if (!quickVoiceWindow) {
    return;
  }

  try {
    const layout = await resolveAssistantSurfaceLayout();

    if (layout) {
      await setWindowPosition(quickVoiceWindow, layout.quickVoicePosition);
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
